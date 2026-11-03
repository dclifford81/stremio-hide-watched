const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const OfficialWB = require('stremio-watched-bitfield')
const { watchedSet, serialize } = require('../src/bitfield')
const { sortVideos, encodeToken } = require('../src/addon')

const ep = (s, e, released = '2020-01-01T00:00:00.000Z') => ({ id: `tt1:${s}:${e}`, season: s, episode: e, released, name: `Ep ${e}` })

test('decodes bitfields written by the official library, including grown lists', () => {
  const ids = ['tt1:1:1', 'tt1:1:2', 'tt1:1:3', 'tt1:1:4', 'tt1:1:5', 'tt1:1:6', 'tt1:1:7', 'tt1:1:8', 'tt1:1:9']
  const s = OfficialWB.constructFromArray([1, 1, 0, 1, 0, 0, 0, 0, 1], ids).serialize()
  assert.deepStrictEqual([...watchedSet(s, ids)], ['tt1:1:1', 'tt1:1:2', 'tt1:1:4', 'tt1:1:9'])
  assert.deepStrictEqual([...watchedSet(s, [...ids, 'tt1:2:1'])], ['tt1:1:1', 'tt1:1:2', 'tt1:1:4', 'tt1:1:9'])
  const ours = serialize(ids, new Set(['tt1:1:3', 'tt1:1:8']))
  const back = OfficialWB.constructAndResize(ours, ids)
  assert.deepStrictEqual(ids.filter((id) => back.getVideo(id)), ['tt1:1:3', 'tt1:1:8'])
})

// --- end to end against fake Stremio API + Cinemeta -----------------------
const videos = [ep(1, 1), ep(1, 2), ep(1, 3), ep(1, 4), ep(2, 1), ep(2, 2), ep(2, 3), ep(0, 1), ep(2, 4, '2099-01-01T00:00:00.000Z')]
const allIds = sortVideos(videos).map((v) => v.id)

function startFakes() {
  // Watched out of order on the normal page: S1E2 and S2E1 (Simpsons-style).
  const realWatched = new Set(['tt1:1:2', 'tt1:2:1'])
  // Then, on our page that hid those two, watched S1E4.
  const token = encodeToken(allIds, realWatched)
  const ourList = allIds.filter((id) => !realWatched.has(id))
  const library = [
    { _id: 'tt1', type: 'series', name: 'Show', removed: false, state: { watched: serialize(allIds, realWatched), lastWatched: '2026-10-01T00:00:00Z' } },
    { _id: `hw:tt1:${token}`, type: 'series', removed: true, temp: true, state: { watched: serialize(ourList, new Set(['tt1:1:4'])), lastWatched: '2026-10-02T00:00:00Z', timesWatched: 1 } },
    { _id: 'tt2', type: 'series', removed: false, state: { watched: serialize(['tt2:1:1'], new Set(['tt2:1:1'])) } },
    { _id: 'tt3', type: 'movie', removed: false, state: {} },
  ]
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/datastoreGet') {
      const { authKey, collection } = JSON.parse(body)
      if (authKey !== 'KEY' || collection !== 'libraryItem') return res.end(JSON.stringify({ error: { code: 1, message: 'Session does not exist' } }))
      return res.end(JSON.stringify({ result: library }))
    }
    if (req.url === '/meta/series/tt1.json') return res.end(JSON.stringify({ meta: { id: 'tt1', type: 'series', name: 'Show', description: 'desc', videos, links: [{ name: 'Comedy', category: 'Genres', url: 'stremio:///discover' }] } }))
    if (req.url === '/meta/series/tt2.json') return res.end(JSON.stringify({ meta: { id: 'tt2', type: 'series', name: 'Done', videos: [{ id: 'tt2:1:1', season: 1, episode: 1, released: '2020-01-01' }] } }))
    if (req.url === '/meta/series/tt9.json') return res.end(JSON.stringify({ meta: { id: 'tt9', type: 'series', name: 'Never watched', videos: [{ id: 'tt9:1:1', season: 1, episode: 1, released: '2020-01-01' }] } }))
    if (req.url === '/catalog/series/top/search=show.json') return res.end(JSON.stringify({ metas: [{ id: 'tt1' }, { id: 'tt9' }] }))
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((r) => server.listen(0, () => r(server)))
}

test('hides every watched episode, with toggle links', async (t) => {
  const fake = await startFakes()
  const base = `http://127.0.0.1:${fake.address().port}`
  const port = 7123
  const proc = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: { ...process.env, PORT: port, STREMIO_API: base, CINEMETA_URL: base }, stdio: 'pipe',
  })
  t.after(() => { proc.kill(); fake.close() })
  await new Promise((r) => proc.stdout.once('data', r))

  const cfg = Buffer.from(JSON.stringify({ authKey: 'KEY' })).toString('base64url')
  const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()

  assert.deepStrictEqual((await get(`/${cfg}/manifest.json`)).catalogs.map((c) => c.id), ['hw-unwatched', 'hw-search'])

  // Row keeps fully watched shows by default; skips movies.
  const { metas } = await get(`/${cfg}/catalog/series/hw-unwatched.json`)
  assert.deepStrictEqual(metas.map((m) => m.id.split(':').slice(0, 2).join(':')), ['hw:tt1', 'hw:tt2'])
  assert.match(metas[0].description, /^4 unwatched · next S1E1 · 3 watched hidden/)

  // The page from the row hides S1E2, S2E1 (normal page) and S1E4 (our page).
  const { meta } = await get(`/${cfg}/meta/series/${encodeURIComponent(metas[0].id)}.json`)
  assert.deepStrictEqual(meta.videos.map((v) => v.id), ['tt1:0:1', 'tt1:1:1', 'tt1:1:3', 'tt1:2:2', 'tt1:2:3', 'tt1:2:4'])
  assert.deepStrictEqual(meta.links[0], { name: '👁 Show all episodes', category: 'Hide Watched', url: 'stremio:///detail/series/tt1' })
  assert.strictEqual(meta.links.length, 2) // ours + Cinemeta's genre link; nothing newly watched
  assert.match(meta.description, /^👁 3 watched episodes hidden/)

  // An older page (before S1E4) keeps its exact list and offers a refresh link.
  const oldToken = encodeToken(allIds, new Set(['tt1:1:2', 'tt1:2:1']))
  const old = (await get(`/${cfg}/meta/series/${encodeURIComponent(`hw:tt1:${oldToken}`)}.json`)).meta
  assert.ok(old.videos.some((v) => v.id === 'tt1:1:4'))
  assert.strictEqual(old.links[1].name, '↻ Hide 1 newly watched')
  assert.strictEqual(old.links[1].url, `stremio:///detail/series/${metas[0].id}`)

  // Search finds shows not in the library too.
  const found = await get(`/${cfg}/catalog/series/hw-search/search=show.json`)
  assert.deepStrictEqual(found.metas.map((m) => m.id), [metas[0].id, 'hw:tt9:-'])

  const hideDone = Buffer.from(JSON.stringify({ authKey: 'KEY', hideCaughtUp: true })).toString('base64url')
  assert.strictEqual((await get(`/${hideDone}/catalog/series/hw-unwatched.json`)).metas.length, 1)

  // A logged-out key shows a reconnect card instead of an error, and pages keep their list.
  const bad = Buffer.from(JSON.stringify({ authKey: 'WRONG' })).toString('base64url')
  const expired = await get(`/${bad}/catalog/series/hw-unwatched.json`)
  assert.deepStrictEqual(expired.metas.map((m) => m.id), ['hw:reconnect'])
  assert.strictEqual(expired.metas[0].links[0].url, `http://127.0.0.1:${port}/configure`)
  const stale = (await get(`/${bad}/meta/series/${encodeURIComponent(metas[0].id)}.json`)).meta
  assert.deepStrictEqual(stale.videos.map((v) => v.id), meta.videos.map((v) => v.id))
  assert.match(stale.description, /^⚠ Your Stremio login/)
  assert.strictEqual((await get(`/${bad}/meta/series/hw%3Areconnect.json`)).meta.name, '⚠ Reconnect Hide Watched')
})
