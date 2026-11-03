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
  const [, resource, type, id, extra] = parts

  if (resource === 'manifest.json') return send(res, 200, addon.manifest)

  const strip = (s) => s && s.replace(/\.json$/, '')
  if (resource === 'catalog' && type === 'series' && strip(id) === addon.CATALOG_ID) {
    const skip = parseInt(new URLSearchParams(strip(extra) || '').get('skip'), 10) || 0
    return send(res, 200, await addon.catalog(config, skip), undefined, { 'cache-control': 'max-age=60' })
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
