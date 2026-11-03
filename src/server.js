const http = require('http')
const fs = require('fs')
const path = require('path')
const addon = require('./addon')

const PORT = process.env.PORT || 7000
const configureHtml = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8')

// Config lives in the addon URL: /<base64url(JSON)>/manifest.json
function decodeConfig(str) {
  try {
    const cfg = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'))
    return typeof cfg.authKey === 'string' && cfg.authKey ? cfg : null
  } catch { return null }
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', ...extra })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, '')
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  if (req.method === 'POST' && url.pathname === '/login') {
    const { email, password } = await readBody(req)
    try {
      const result = await addon.login(email, password)
      return send(res, 200, { authKey: result.authKey })
    } catch (e) {
      return send(res, 401, { error: e.message })
    }
  }

  if (parts.length === 0) return send(res, 302, '', 'text/plain', { location: '/configure' })
  if (parts.at(-1) === 'configure') return send(res, 200, configureHtml, 'text/html; charset=utf-8')
  if (parts.length === 1 && parts[0] === 'manifest.json') {
    return send(res, 200, { ...addon.manifest, behaviorHints: { configurable: true, configurationRequired: true } })
  }

  const config = decodeConfig(parts[0])
  if (!config) return send(res, 404, { error: 'not found' })
  config.origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`
  const [, resource, type, id, extra] = parts

  if (resource === 'manifest.json') return send(res, 200, addon.manifest)

  const strip = (s) => s && s.replace(/\.json$/, '')
  if (resource === 'catalog' && type === 'series' && [addon.CATALOG_ID, addon.SEARCH_ID].includes(strip(id))) {
    const params = new URLSearchParams(strip(extra) || '')
    const search = strip(id) === addon.SEARCH_ID ? params.get('search') : null
    if (strip(id) === addon.SEARCH_ID && !search) return send(res, 200, { metas: [] })
    const skip = parseInt(params.get('skip'), 10) || 0
    return send(res, 200, await addon.catalog(config, { skip, search }), undefined, { 'cache-control': 'max-age=30' })
  }
  if (resource === 'meta' && type === 'series' && id) {
    return send(res, 200, await addon.metaFor(config, strip(id)), undefined, { 'cache-control': 'max-age=60' })
  }
  return send(res, 404, { error: 'not found' })
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err)
    send(res, 500, { error: err.message })
  })
}).listen(PORT, () => console.log(`Hide Watched addon on http://127.0.0.1:${PORT}/configure`))

// Render's free plan puts the server to sleep after 15 idle minutes, and waking it takes about
// a minute, which Stremio shows as "still fetching catalogs". Pinging our own public URL keeps
// it awake; one always-on service fits in the free plan's 750 hours a month. KEEP_AWAKE=0 stops it.
const SELF_URL = process.env.RENDER_EXTERNAL_URL
if (SELF_URL && process.env.KEEP_AWAKE !== '0') {
  setInterval(() => fetch(`${SELF_URL}/manifest.json`).catch(() => {}), 10 * 60e3).unref()
}
