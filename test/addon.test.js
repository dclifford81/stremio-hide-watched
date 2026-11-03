const test = require('node:test')
const assert = require('node:assert')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')
const OfficialWB = require('stremio-watched-bitfield')
const { watchedSet, watchedSetFromWindow, serialize } = require('../src/bitfield')

const ep = (s, e, released = '2020-01-01T00:00:00.000Z') => ({ id: `tt1:${s}:${e}`, season: s, episode: e, released, name: `Ep ${e}` })

test('decodes bitfields written by the official library, including shifted/grown lists', () => {
  const ids = ['tt1:1:1', 'tt1:1:2', 'tt1:1:3', 'tt1:1:4', 'tt1:1:5', 'tt1:1:6', 'tt1:1:7', 'tt1:1:8', 'tt1:1:9']
  const wb = OfficialWB.constructFromArray([1, 1, 0, 1, 0, 0, 0, 0, 1], ids)
  const s = wb.serialize()
  assert.deepStrictEqual([...watchedSet(s, ids)], ['tt1:1:1', 'tt1:1:2', 'tt1:1:4', 'tt1:1:9'])
  // new episode pushed to the back
  assert.deepStrictEqual([...watchedSet(s, [...ids, 'tt1:2:1'])], ['tt1:1:1', 'tt1:1:2', 'tt1:1:4', 'tt1:1:9'])
  // our own serializer round-trips through the official one
  const ours = serialize(ids, new Set(['tt1:1:3', 'tt1:1:8']))
  const back = OfficialWB.constructAndResize(ours, ids)
  assert.deepStrictEqual(ids.filter((id) => back.getVideo(id)), ['tt1:1:3', 'tt1:1:8'])
})

test('window decode recovers progress recorded against a tail of the list', () => {
  const universe = ['a', 'b', 'c', 'd', 'e', 'f']
  // app recorded against tail [c..f], with d watched; later 'g' got released
  const s = serialize(['c', 'd', 'e', 'f'], new Set(['d']))
  assert.deepStrictEqual([...watchedSetFromWindow(s, [...universe, 'g'])], ['d'])
  // and stremio's own resize of that bitfield to a shorter tail keeps it aligned
  const resized = OfficialWB.constructAndResize(s, ['d', 'e', 'f'])
  assert.strictEqual(resized.getVideo('d'), true)
  assert.strictEqual(resized.getVideo('e'), false)
})

// --- end to end against fake Stremio API + Cinemeta -----------------------
function startFakes() {
  const videos = [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1), ep(2, 2), ep(0, 1), ep(2, 3, '2099-01-01T00:00:00.000Z')]
  const fullIds = require('../src/addon').sortVideos(videos).map((v) => v.id)
  const tailIds = ['tt1:1:3', 'tt1:2:1', 'tt1:2:2', 'tt1:2:3']
  const library = [
    // watched S1E1, S1E2 normally
    { _id: 'tt1', type: 'series', name: 'Show', removed: false, state: { watched: serialize(fullIds, new Set(['tt1:1:1', 'tt1:1:2'])), lastWatched: '2026-10-01T00:00:00Z' } },
    // then watched S1E3 from our hw: item
    { _id: 'hw:tt1', type: 'series', removed: true, temp: true, state: { watched: serialize(tailIds, new Set(['tt1:1:3'])), lastWatched: '2026-10-02T00:00:00Z', timesWatched: 1 } },
    // fully watched show -> hidden from catalog
    { _id: 'tt2', type: 'series', removed: false, state: { watched: serialize(['tt2:1:1'], new Set(['tt2:1:1'])) } },
    { _id: 'tt3', type: 'movie', removed: false, state: {} },
  ]
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/datastoreGet') {
      const { authKey, collection } = JSON.parse(body)
      if (authKey !== 'KEY' || collection !== 'libraryItem') return res.end(JSON.stringify({ error: { message: 'bad session' } }))
      return res.end(JSON.stringify({ result: library }))
    }
    if (req.url === '/meta/series/tt1.json') return res.end(JSON.stringify({ meta: { id: 'tt1', type: 'series', name: 'Show', description: 'desc', videos } }))
    if (req.url === '/meta/series/tt2.json') return res.end(JSON.stringify({ meta: { id: 'tt2', type: 'series', name: 'Done', videos: [{ id: 'tt2:1:1', season: 1, episode: 1, released: '2020-01-01' }] } }))
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((r) => server.listen(0, () => r(server)))
}

test('catalog and meta hide watched episodes', async (t) => {
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

  const manifest = await get(`/${cfg}/manifest.json`)
  assert.strictEqual(manifest.catalogs[0].id, 'hw-unwatched')
  assert.strictEqual((await get('/manifest.json')).behaviorHints.configurationRequired, true)

  const { metas } = await get(`/${cfg}/catalog/series/hw-unwatched.json`)
  assert.deepStrictEqual(metas.map((m) => m.id), ['hw:tt1'])
  assert.match(metas[0].description, /Next: S2E1 · 2 unwatched/)

  const { meta } = await get(`/${cfg}/meta/series/${encodeURIComponent('hw:tt1')}.json`)
  assert.deepStrictEqual(meta.videos.map((v) => v.id), ['tt1:2:1', 'tt1:2:2', 'tt1:2:3'])
  assert.strictEqual(meta.id, 'hw:tt1')

  const bad = Buffer.from(JSON.stringify({ authKey: 'WRONG' })).toString('base64url')
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/${bad}/catalog/series/hw-unwatched.json`)).status, 500)
})
