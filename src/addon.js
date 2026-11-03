const { watchedSet, watchedSetFromWindow } = require('./bitfield')

const STREMIO_API = process.env.STREMIO_API || 'https://api.strem.io'
const CINEMETA = process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io'
const PREFIX = 'hw:'
const CATALOG_ID = 'hw-unwatched'
const PAGE_SIZE = 100

const manifest = {
  id: 'community.hidewatched',
  version: '1.0.0',
  name: 'Hide Watched Episodes',
  description: 'Your shows with already-watched episodes hidden. Opens each show at the next episode you haven\'t seen.',
  resources: ['catalog', { name: 'meta', types: ['series'], idPrefixes: [PREFIX] }],
  types: ['series'],
  idPrefixes: [PREFIX],
  catalogs: [{ type: 'series', id: CATALOG_ID, name: 'Up Next (unwatched)', extra: [{ name: 'skip' }] }],
  behaviorHints: { configurable: true },
}

// --- tiny TTL cache ---------------------------------------------------------
const cache = new Map()
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const value = await fn()
  cache.set(key, { value, expires: Date.now() + ttlMs })
  return value
}

// --- remote data ------------------------------------------------------------
async function stremioApi(method, body) {
  const res = await fetch(`${STREMIO_API}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'Stremio API error')
  return json.result
}

function login(email, password) {
  return stremioApi('login', { type: 'Login', email, password, facebook: false })
}

function fetchLibrary(authKey) {
  return cached(`lib:${authKey}`, 30e3, () =>
    stremioApi('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true }))
}

function fetchMeta(imdbId) {
  return cached(`meta:${imdbId}`, 6 * 3600e3, async () => {
    const res = await fetch(`${CINEMETA}/meta/series/${imdbId}.json`)
    if (!res.ok) return null
    const { meta } = await res.json()
    return meta && Array.isArray(meta.videos) ? meta : null
  })
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

// Our "hw:" metas list a contiguous tail of the episode list (everything from the first
// unwatched episode onward, specials excluded). Keeping it a tail matters: Stremio's
// bitfield survives videos being dropped from the front, so progress the app records
// against our hw: item stays decodable and never gets wiped.
function computeState(meta, realItem, ourItem) {
  const all = sortVideos(meta.videos)
  const universe = all.filter((v) => v.season !== 0)
  const ids = universe.map((v) => v.id)
  const watched = watchedSet(realItem?.state?.watched, all.map((v) => v.id))
  for (const id of watchedSetFromWindow(ourItem?.state?.watched, ids)) watched.add(id)

  let start = ids.findIndex((id) => !watched.has(id))
  if (start === -1) start = ids.length
  const visible = universe.slice(start)
  const now = Date.now()
  const releasedLeft = visible.filter((v) => !watched.has(v.id) && (!v.released || Date.parse(v.released) <= now))
  return { visible, releasedLeft, next: visible[0] }
}

function groupLibrary(items) {
  const shows = new Map()
  for (const item of items || []) {
    if (item.type !== 'series' || typeof item._id !== 'string') continue
    const ours = item._id.startsWith(PREFIX)
    const base = ours ? item._id.slice(PREFIX.length) : item._id
    if (!base.startsWith('tt')) continue
    const show = shows.get(base) || { id: base }
    show[ours ? 'ours' : 'real'] = item
    shows.set(base, show)
  }
  const active = (it) => it && (!it.removed || it.state?.timesWatched > 0 || it.state?.watched)
  const lastSeen = (it) => Math.max(Date.parse(it?.state?.lastWatched || 0) || 0, Date.parse(it?._mtime || 0) || 0)
  return [...shows.values()]
    .filter((s) => active(s.real) || active(s.ours))
    .map((s) => ({ ...s, lastSeen: Math.max(lastSeen(s.real), lastSeen(s.ours)) }))
    .sort((a, b) => b.lastSeen - a.lastSeen)
}

const epLabel = (v) => `S${v.season}E${v.episode}`

async function catalog(config, skip = 0) {
  const shows = groupLibrary(await fetchLibrary(config.authKey))
  const rows = await mapLimit(shows, 8, async (show) => {
    const meta = await fetchMeta(show.id)
    if (!meta) return null
    const st = computeState(meta, show.real, show.ours)
    if (config.hideCaughtUp !== false && st.releasedLeft.length === 0) return null
    const left = st.releasedLeft.length
    return {
      id: PREFIX + show.id,
      type: 'series',
      name: meta.name,
      poster: meta.poster,
      background: meta.background,
      logo: meta.logo,
      releaseInfo: meta.releaseInfo,
      description: st.releasedLeft[0]
        ? `Next: ${epLabel(st.releasedLeft[0])} · ${left} unwatched episode${left === 1 ? '' : 's'}`
        : 'All caught up',
    }
  })
  return { metas: rows.filter(Boolean).slice(skip, skip + PAGE_SIZE) }
}

async function metaFor(config, id) {
  if (!id.startsWith(PREFIX)) return { meta: null }
  const base = id.slice(PREFIX.length)
  const [meta, library] = await Promise.all([fetchMeta(base), fetchLibrary(config.authKey)])
  if (!meta) return { meta: null }
  const show = groupLibrary(library).find((s) => s.id === base) || {}
  const st = computeState(meta, show.real, show.ours)
  const note = st.releasedLeft.length
    ? `▶ Next up: ${epLabel(st.releasedLeft[0])} · ${st.releasedLeft.length} unwatched`
    : '✓ All caught up'
  return {
    meta: { ...meta, id, videos: st.visible, description: `${note}\n\n${meta.description || ''}`.trim() },
    // Short cache so the list refreshes soon after you finish an episode.
    cacheMaxAge: 60,
  }
}

module.exports = { manifest, catalog, metaFor, login, computeState, sortVideos, CATALOG_ID, PREFIX }
