const { watchedSet, anchor, serialize } = require('./bitfield')

const STREMIO_API = process.env.STREMIO_API || 'https://api.strem.io'
const CINEMETA = process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io'
const PREFIX = 'hw:'
const CATALOG_ID = 'hw-unwatched'
const SEARCH_ID = 'hw-search'
const PAGE_SIZE = 100
const LINK_CATEGORY = 'Hide Watched'

const manifest = {
  id: 'community.hidewatched',
  version: '2.2.0',
  name: 'Hide Watched Episodes',
  description: 'Open any TV series with the episodes you\'ve already watched hidden. Use "Show all episodes" on the show page to switch back.',
  resources: ['catalog', { name: 'meta', types: ['series'], idPrefixes: [PREFIX] }],
  types: ['series'],
  idPrefixes: [PREFIX],
  catalogs: [
    { type: 'series', id: CATALOG_ID, name: 'Continue Watching (unwatched only)', extra: [{ name: 'skip' }] },
    { type: 'series', id: SEARCH_ID, name: 'Hide Watched', extra: [{ name: 'search', isRequired: true }] },
  ],
  behaviorHints: { configurable: true },
}

// --- tiny TTL cache ---------------------------------------------------------
const cache = new Map()
const inflight = new Map()
function load(key, ttlMs, fn) {
  if (!inflight.has(key)) {
    inflight.set(key, fn()
      .then((value) => { cache.set(key, { value, expires: Date.now() + ttlMs }); return value })
      .finally(() => inflight.delete(key)))
  }
  return inflight.get(key)
}
// With stale: true an expired value is served at once while it refreshes in the background.
async function cached(key, ttlMs, fn, { stale = false } = {}) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  if (hit && stale) {
    load(key, ttlMs, fn).catch(() => {})
    return hit.value
  }
  return load(key, ttlMs, fn)
}

// --- remote data ------------------------------------------------------------
async function stremioApi(method, body) {
  const res = await fetch(`${STREMIO_API}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (json.error) {
    const err = new Error(json.error.message || 'Stremio API error')
    // code 1 = "Session does not exist": the auth key was logged out.
    err.sessionExpired = json.error.code === 1
    throw err
  }
  return json.result
}

function login(email, password) {
  return stremioApi('login', { type: 'Login', email, password, facebook: false })
}

// The auth key inside an installed copy's URL (…/<base64url config>/manifest.json), if any.
function keyInUrl(transportUrl) {
  try {
    const segment = new URL(transportUrl).pathname.split('/').filter(Boolean)[0]
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')).authKey
  } catch { return undefined }
}

// Stremio shows addon rows on the Board in the account's addon order, puts new installs last,
// and has no way to reorder them in the apps. Moving this addon to the front puts its row
// right under Continue Watching. Other copies of it (an old host, or a logged-out key) would
// show a second row, so they're removed.
async function moveToTop(authKey) {
  const { addons } = await stremioApi('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })
  const isOurs = (a) => a.manifest?.id === manifest.id
  const current = addons.filter((a) => isOurs(a) && keyInUrl(a.transportUrl) === authKey)
  if (!current.length) throw new Error('This login\'s copy of the addon isn\'t installed yet. Install it first, then try again.')
  const removed = addons.filter((a) => isOurs(a) && !current.includes(a))
  const rest = addons.filter((a) => !isOurs(a))
  await stremioApi('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons: [current[0], ...rest] })
  log(`moved to top ahead of ${rest.length} addons, removed ${removed.length} old cop${removed.length === 1 ? 'y' : 'ies'}`)
  return { removed: removed.length }
}

function fetchLibrary(authKey) {
  return cached(`lib:${authKey}`, 20e3, () =>
    stremioApi('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true }))
}

function fetchMeta(imdbId) {
  return cached(`meta:${imdbId}`, 6 * 3600e3, async () => {
    const res = await fetch(`${CINEMETA}/meta/series/${imdbId}.json`)
    if (!res.ok) return null
    const { meta } = await res.json()
    return meta && Array.isArray(meta.videos) ? meta : null
  }, { stale: true })
}

function searchSeries(query) {
  return cached(`search:${query.toLowerCase()}`, 3600e3, async () => {
    const res = await fetch(`${CINEMETA}/catalog/series/top/search=${encodeURIComponent(query)}.json`)
    if (!res.ok) return []
    return (await res.json()).metas || []
  }, { stale: true })
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]).catch(() => null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// --- watched-state logic ----------------------------------------------------
// Same ordering stremio-core uses when building a bitfield: season, episode, released.
const MIN = -Infinity
const key = (v) => [v.season ?? MIN, v.episode ?? MIN, v.released ? Date.parse(v.released) : MIN]
function sortVideos(videos) {
  return [...videos].sort((a, b) => {
    const ka = key(a), kb = key(b)
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    return 0
  })
}

// Our pages have ids like "hw:tt0096697:<token>", where the token is the watched set the
// page hides. Stremio records progress made on our page against our page's own episode
// list, so that list must never change for a given id (or the app would misread its
// own bitfield). Baking the hidden set into the id makes every id's list fixed, and lets
// us decode the progress later. A new set of watched episodes simply means a new id.
const EMPTY_TOKEN = '-'
function encodeToken(allIds, watched) {
  return watched.size ? Buffer.from(serialize(allIds, watched)).toString('base64url') : EMPTY_TOKEN
}
function decodeToken(token, allIds) {
  if (!token || token === EMPTY_TOKEN) return new Set()
  return watchedSet(Buffer.from(token, 'base64url').toString('utf8'), allIds)
}

function parseId(id) {
  if (!id.startsWith(PREFIX)) return null
  const [base, ...rest] = id.slice(PREFIX.length).split(':')
  return base.startsWith('tt') ? { base, token: rest.join(':') } : null
}

// Stremio versions disagree on the episode order a watched bitfield is built against:
// current stremio-core source sorts specials (season 0) first, while the shipping apps put
// them last (their MetaItem order), and older ones used the addon's own order. Reading
// with the wrong order shifts every flag (e.g. by 74 specials on The Simpsons), so pick
// the order whose position for the bitfield's anchor (its last id + length) lines up.
function specialsLast(videos) {
  const k = (v) => [v.season === 0 ? Infinity : v.season ?? MIN, v.episode ?? MIN, v.released ? Date.parse(v.released) : MIN]
  return [...videos].sort((a, b) => {
    const ka = k(a), kb = k(b)
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    return 0
  })
}
const uniqueIds = (videos) => [...new Set(videos.map((v) => v.id))]

function decodeWatched(serialized, videos) {
  const a = anchor(serialized)
  if (!a) return { set: new Set(), order: null }
  const orders = { 'specials-last': specialsLast(videos), 'specials-first': sortVideos(videos), 'addon': videos }
  let best = null
  for (const [order, list] of Object.entries(orders)) {
    const ids = uniqueIds(list)
    const idx = ids.indexOf(a.lastVideoId)
    // New episodes appended after the anchor keep offset 0; a positive offset means
    // episodes vanished from the front, which Cinemeta practically never does.
    const offset = a.lastLength - 1 - idx
    if (idx === -1 || offset < 0 || offset > 3) continue
    if (!best || offset < best.offset) best = { order, ids, offset }
    if (offset === 0) break
  }
  return best ? { set: watchedSet(serialized, best.ids), order: best.order } : { set: new Set(), order: 'unmatched' }
}

// Everything watched so far: the normal library item plus progress made on any of our pages.
function watchedNow(videos, allIds, show) {
  const real = decodeWatched(show?.real?.state?.watched, videos)
  const watched = real.set
  for (const { token, item } of show?.ours || []) {
    if (!token) continue
    const hidden = decodeToken(token, allIds)
    for (const id of decodeWatched(item.state?.watched, videos.filter((v) => !hidden.has(v.id))).set) watched.add(id)
  }
  return { watched, order: real.order }
}

function groupLibrary(items) {
  const shows = new Map()
  const get = (base) => shows.get(base) || shows.set(base, { id: base, ours: [] }).get(base)
  for (const item of items || []) {
    if (item.type !== 'series' || typeof item._id !== 'string') continue
    const parsed = parseId(item._id)
    if (parsed) get(parsed.base).ours.push({ token: parsed.token, item })
    else if (item._id.startsWith('tt')) get(item._id).real = item
  }
  const active = (it) => it && (!it.removed || it.state?.timesWatched > 0 || it.state?.watched)
  const lastSeen = (it) => Math.max(Date.parse(it?.state?.lastWatched || 0) || 0, Date.parse(it?._mtime || 0) || 0)
  return new Map([...shows.values()]
    .filter((s) => active(s.real) || s.ours.some((o) => active(o.item)))
    .map((s) => ({ ...s, lastSeen: Math.max(lastSeen(s.real), ...s.ours.map((o) => lastSeen(o.item))) }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((s) => [s.id, s]))
}

const epLabel = (v) => `S${v.season}E${v.episode}`
const isReleased = (v) => !v.released || Date.parse(v.released) <= Date.now()

function summarize(meta, show) {
  // Tokens are always encoded against this one order (it must never change between deploys).
  const videos = sortVideos(meta.videos)
  const allIds = videos.map((v) => v.id)
  const { watched, order } = watchedNow(meta.videos, allIds, show)
  // Specials stay in the episode list but don't count towards "unwatched"/"next".
  const unwatched = videos.filter((v) => !watched.has(v.id) && isReleased(v) && v.season !== 0)
  return { videos, allIds, watched, unwatched, order, token: encodeToken(allIds, watched) }
}

function card(meta, id, description) {
  const { name, poster, background, logo, releaseInfo } = meta
  return { id, type: 'series', name, poster, background, logo, releaseInfo, description }
}

function preview(meta, base, s) {
  const left = s.unwatched.length
  return card(meta, `${PREFIX}${base}:${s.token}`, left
    ? `${left} unwatched · next ${epLabel(s.unwatched[0])} · ${s.watched.size} watched hidden`
    : 'All caught up')
}

// Shown instead of an error when Stremio rejects the auth key, so the app says what to do.
const RECONNECT_ID = `${PREFIX}reconnect`
const RECONNECT_TEXT = 'Your Stremio login for this addon has expired (it happens when the session it came from logs out). Open the setup page, connect again, and install the new addon link.'
function reconnectMeta(config) {
  return {
    id: RECONNECT_ID,
    type: 'series',
    name: '⚠ Reconnect Hide Watched',
    description: RECONNECT_TEXT,
    links: config.origin ? [{ name: 'Open setup page', category: LINK_CATEGORY, url: `${config.origin}/configure` }] : [],
  }
}

async function libraryOrExpired(config) {
  try {
    return { library: await fetchLibrary(config.authKey) }
  } catch (e) {
    if (e.sessionExpired) {
      log('library: session expired, showing reconnect card')
      return { expired: true, library: [] }
    }
    throw e
  }
}

// Diagnostics for Render's Logs tab. Never logs the auth key.
function log(msg) {
  if (!process.env.QUIET) console.log(`[hide-watched] ${msg}`)
}

async function catalog(config, { skip = 0, search } = {}) {
  const { library, expired } = await libraryOrExpired(config)
  if (expired) return { metas: skip ? [] : [reconnectMeta(config)] }
  const shows = groupLibrary(library)
  if (search) {
    const results = (await searchSeries(search)).filter((r) => r.id?.startsWith('tt')).slice(0, 20)
    // Only shows in the library need their episode lists; the rest have nothing to hide yet.
    const rows = await mapLimit(results, 8, async (r) => {
      const show = shows.get(r.id)
      if (!show) return card(r, `${PREFIX}${r.id}:${EMPTY_TOKEN}`, 'Not started')
      const meta = await fetchMeta(r.id)
      return meta && preview(meta, r.id, summarize(meta, show))
    })
    log(`search "${search}": ${rows.filter(Boolean).length} results`)
    return { metas: rows.filter(Boolean) }
  }
  const orders = {}
  const rows = await mapLimit([...shows.values()], 8, async (show) => {
    const meta = await fetchMeta(show.id)
    if (!meta) return null
    const s = summarize(meta, show)
    orders[s.order] = (orders[s.order] || 0) + 1
    if (config.hideCaughtUp && s.unwatched.length === 0) return null
    return preview(meta, show.id, s)
  })
  log(`row: ${library.length} library items, ${shows.size} series, ${rows.filter(Boolean).length} shown; watched-list order ${JSON.stringify(orders)}`)
  return { metas: rows.filter(Boolean).slice(skip, skip + PAGE_SIZE) }
}

async function metaFor(config, id) {
  if (id === RECONNECT_ID) return { meta: reconnectMeta(config), cacheMaxAge: 0 }
  const parsed = parseId(id)
  if (!parsed) return { meta: null }
  const [meta, { library, expired }] = await Promise.all([fetchMeta(parsed.base), libraryOrExpired(config)])
  if (!meta) return { meta: null }
  // With an expired key the page still serves exactly its token's list, just with a warning.
  const s = summarize(meta, groupLibrary(library).get(parsed.base))
  // The list for this id comes from its token only (see encodeToken); a bare "hw:tt…"
  // id has no token, so it falls back to what's watched right now.
  const hidden = parsed.token ? decodeToken(parsed.token, s.allIds) : s.watched
  const videos = s.videos.filter((v) => !hidden.has(v.id))
  const show = groupLibrary(library).get(parsed.base)
  log(`show ${parsed.base} "${meta.name}": ${s.allIds.length} episodes, ${s.watched.size} watched (order ${s.order}, ${show?.ours.length || 0} addon-page items), this page hides ${hidden.size}, lists ${videos.length}`)

  const links = [{ name: '👁 Show all episodes', category: LINK_CATEGORY, url: `stremio:///detail/series/${parsed.base}` }]
  const newlyWatched = videos.filter((v) => s.watched.has(v.id)).length
  if (newlyWatched) {
    links.push({ name: `↻ Hide ${newlyWatched} newly watched`, category: LINK_CATEGORY, url: `stremio:///detail/series/${PREFIX}${parsed.base}:${s.token}` })
  }
  if (expired) links.push(...reconnectMeta(config).links)
  const note = expired
    ? `⚠ ${RECONNECT_TEXT}`
    : `👁 ${hidden.size} watched episode${hidden.size === 1 ? '' : 's'} hidden`
  return {
    meta: {
      ...meta,
      id,
      videos,
      links: [...links, ...(meta.links || [])],
      description: `${note}\n\n${meta.description || ''}`.trim(),
    },
    cacheMaxAge: expired ? 0 : 60,
  }
}

module.exports = { manifest, catalog, metaFor, login, moveToTop, sortVideos, encodeToken, decodeWatched, CATALOG_ID, SEARCH_ID, PREFIX }
