import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES, CollabError } from '../collab/src/errors.mjs'
import { isUninitialised } from '../collab/src/api.mjs'
import { readKitFiles } from './kit-files.mjs'
import { detectSetup, previewSetup } from './setup-wizard.mjs'
import { eventsView, overviewView, rosterView, setupCheckView, tasksView, taskView, waitingView } from './views.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_ROOT = realpathSync(join(HERE, 'public'))
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
const MIME = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const PREVIEW_KEYS = new Set(['agents', 'lead', 'single_vendor', 't'])

const panelHeaders = () => ({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
})

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

// A request from another origin (a page on another local port, a site the owner has open) is refused before it
// reaches any data, whatever token it carries: the panel is only ever driven by its own page.
function foreignOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return `Sec-Fetch-Site: ${site}`
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return `Origin: ${origin}`
  return null
}

function scrub(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]))
  if (typeof value !== 'string') return value
  let clean = value
  for (const secret of secrets) if (secret && secret.length >= 8) clean = clean.split(secret).join(secret === homedir() ? '~' : '[redacted]')
  return clean
}

function send(res, status, body, { head = false, headers = {}, secrets = [] } = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(scrub(body, secrets))
  res.writeHead(status, { ...panelHeaders(), 'Content-Length': Buffer.byteLength(payload), ...headers })
  res.end(head ? undefined : payload)
}

function sendJson(res, status, body, options = {}) {
  send(res, status, body, { ...options, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(options.headers || {}) } })
}

function fail(res, status, code, message, options = {}) {
  sendJson(res, status, { error: { code, message } }, options)
}

function staticFile(rawPath) {
  if (rawPath.includes('\\') || /%2e|%2f|%5c/i.test(rawPath) || rawPath.includes('..')) return null
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    return null
  }
  if (path === '/') path = '/index.html'
  if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) return null
  const file = join(PUBLIC_ROOT, path.slice(1))
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const real = realpathSync(file)
    if (!real.startsWith(`${PUBLIC_ROOT}${sep}`)) return null
    return real
  } catch {
    return null
  }
}

function initHint(cwd) {
  return { initialized: false, hint: { command: 'collab init', run_in: cwd } }
}

function tailEvents(eventsFile, res, clock, secrets) {
  let offset = 0
  let inode = null
  try {
    const stat = statSync(eventsFile)
    offset = stat.size
    inode = stat.ino
  } catch {
    // The file may not exist until the first event is appended.
  }
  let closed = false

  const flush = () => {
    try {
      if (closed || !existsSync(eventsFile)) return
      const stat = statSync(eventsFile)
      if (inode !== null && stat.ino !== inode) offset = 0
      if (stat.size < offset) offset = 0
      inode = stat.ino
      if (stat.size === offset) return
      const length = stat.size - offset
      const buffer = Buffer.alloc(length)
      const fd = openSync(eventsFile, 'r')
      try {
        readSync(fd, buffer, 0, length, offset)
      } finally {
        closeSync(fd)
      }
      const text = buffer.toString('utf8')
      const newline = text.lastIndexOf('\n')
      if (newline === -1) return
      offset += Buffer.byteLength(text.slice(0, newline + 1))
      for (const line of text.slice(0, newline).split('\n')) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          event = { ts: null, type: 'log.unparseable', data: { line: line.slice(0, 200) } }
        }
        // The stream bypasses send(), so it scrubs on its own: an event can carry
        // an absolute path or a value from the environment like any other body.
        res.write(`data: ${JSON.stringify(scrub(event, secrets))}\n\n`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        offset = 0
        inode = null
      } else {
        res.write('event: error\ndata: {"error":{"code":"STREAM_READ_FAILED","message":"The event log could not be read"}}\n\n')
      }
    }
  }

  let watcher = null
  try {
    watcher = watch(dirname(eventsFile), (_event, name) => {
      if (!name || String(name) === basename(eventsFile)) flush()
    })
    watcher.on('error', () => {})
  } catch {
    // An initialized journal has a parent directory; a disappearing one is
    // reported by the next API request rather than crashing this connection.
  }
  const keepalive = (clock?.setInterval || setInterval)(() => res.write(': keepalive\n\n'), 25_000)
  const stop = () => {
    if (closed) return
    closed = true
    watcher?.close()
    ;(clock?.clearInterval || clearInterval)(keepalive)
  }
  res.on('close', stop)
  return stop
}

export async function startPanel({
  port = 0,
  host = '127.0.0.1',
  token,
  apiFactory,
  kitRoot = resolve(HERE, '..'),
  registryDir,
  machineDir,
  cwd = process.cwd(),
  clock = null
} = {}) {
  if (host !== '127.0.0.1') throw new CollabError(CODES.INVALID_INPUT, 'the panel only listens on 127.0.0.1')
  if (typeof token !== 'string' || token.length < 16) throw new CollabError(CODES.INVALID_INPUT, 'the panel needs a random token')
  if (typeof apiFactory !== 'function') throw new CollabError(CODES.INVALID_INPUT, 'the panel needs an apiFactory')

  const streams = new Set()
  const envSecrets = Object.values(process.env).filter((value) => typeof value === 'string' && value.length >= 8)
  const secrets = [token, homedir(), ...envSecrets]
  let server

  const handler = async (req, res) => {
    const address = server.address()
    const expectedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
    const options = { head: req.method === 'HEAD', secrets }
    if (!expectedHosts.has(req.headers.host || '')) return fail(res, 403, 'FORBIDDEN_HOST', 'Host is not the local panel address', options)
    if (!SAFE_METHODS.has(req.method)) return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', { ...options, headers: { Allow: 'GET, HEAD' } })

    let url
    try {
      url = new URL(req.url, `http://${req.headers.host}`)
    } catch {
      return fail(res, 400, 'INVALID_URL', 'The request URL is invalid', options)
    }
    // The page and its script carry no journal data, so they are served to any navigation (a link clicked in
    // another site arrives as Sec-Fetch-Site: cross-site). Everything under /api/ needs the same origin and the
    // token as a header (or ?t= for the event stream, which cannot send headers). No cookie: every port shares it.
    const authHeaders = {}
    if (!url.pathname.startsWith('/api/')) {
      const file = staticFile(req.url.split('?')[0])
      if (!file) return fail(res, 404, 'NOT_FOUND', 'No such panel resource', options)
      let content
      try {
        content = await import('node:fs/promises').then(({ readFile }) => readFile(file))
      } catch {
        return fail(res, 404, 'NOT_FOUND', 'No such panel resource', options)
      }
      return send(res, 200, content, { ...options, headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' } })
    }
    const foreign = foreignOrigin(req)
    if (foreign) return fail(res, 403, 'FORBIDDEN_ORIGIN', `Cross-origin requests are refused (${foreign})`, options)
    const supplied = req.headers['x-panel-token'] || (url.pathname === '/api/stream' ? url.searchParams.get('t') : null)
    if (!sameSecret(supplied, token)) return fail(res, 403, 'FORBIDDEN', 'A valid panel token is required', options)

    try {
      if (url.pathname === '/api/setup/detect') {
        return sendJson(res, 200, detectSetup({ registryDir, machineDir, cwd }), { ...options, headers: authHeaders })
      }
      if (url.pathname === '/api/setup/preview') {
        if ([...url.searchParams.keys()].some((key) => !PREVIEW_KEYS.has(key))) {
          return fail(res, 400, 'INVALID_INPUT', 'Only agents, lead and single_vendor are accepted', options)
        }
        const agentsValues = url.searchParams.getAll('agents')
        const leadValues = url.searchParams.getAll('lead')
        const vendorValues = url.searchParams.getAll('single_vendor')
        if (agentsValues.length !== 1 || leadValues.length !== 1 || vendorValues.length !== 1) {
          return fail(res, 400, 'INVALID_INPUT', 'agents, lead and single_vendor are each required once', options)
        }
        const answer = previewSetup({
          agents: agentsValues[0].split(',').filter(Boolean),
          lead: leadValues[0],
          singleVendor: vendorValues[0],
          registryDir,
          machineDir,
          cwd
        })
        return sendJson(res, 200, answer, { ...options, headers: authHeaders })
      }
      if (url.pathname === '/api/kit') return sendJson(res, 200, readKitFiles(kitRoot), { ...options, headers: authHeaders })

      let api
      try {
        api = await apiFactory()
      } catch (error) {
        if (isUninitialised(error) && url.pathname === '/api/overview') {
          return sendJson(res, 200, initHint(cwd), { ...options, headers: authHeaders })
        }
        throw error
      }

      if (url.pathname === '/api/overview') return sendJson(res, 200, await overviewView(api), { ...options, headers: authHeaders })
      if (url.pathname === '/api/tasks') {
        const open = url.searchParams.get('open')
        const filters = {
          ...(open === '1' ? { open: true } : open === '0' ? { open: false } : {}),
          ...(url.searchParams.get('status') ? { status: url.searchParams.get('status') } : {}),
          ...(url.searchParams.get('owner') ? { owner: url.searchParams.get('owner') } : {})
        }
        return sendJson(res, 200, await tasksView(api, filters), { ...options, headers: authHeaders })
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)
      if (taskMatch) return sendJson(res, 200, await taskView(api, decodeURIComponent(taskMatch[1])), { ...options, headers: authHeaders })
      if (url.pathname === '/api/waiting') return sendJson(res, 200, await waitingView(api), { ...options, headers: authHeaders })
      if (url.pathname === '/api/events') {
        const raw = url.searchParams.get('limit') || '100'
        if (!/^\d+$/.test(raw) || Number(raw) > 500) return fail(res, 400, 'INVALID_INPUT', 'limit must be an integer from 0 to 500', options)
        if (raw === '0') return sendJson(res, 200, [], { ...options, headers: authHeaders })
        return sendJson(res, 200, eventsView(api, Number(raw)), { ...options, headers: authHeaders })
      }
      if (url.pathname === '/api/roster') return sendJson(res, 200, rosterView(api), { ...options, headers: authHeaders })
      if (url.pathname === '/api/setup/check') return sendJson(res, 200, setupCheckView(api), { ...options, headers: authHeaders })
      if (url.pathname === '/api/stream') {
        if (req.method === 'HEAD') {
          res.writeHead(200, { ...panelHeaders(), ...authHeaders, 'Content-Type': 'text/event-stream; charset=utf-8' })
          return res.end()
        }
        res.writeHead(200, {
          ...panelHeaders(),
          ...authHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive'
        })
        res.write(': connected\n\n')
        const stop = tailEvents(api.store.paths.events, res, clock, secrets)
        streams.add(stop)
        res.on('close', () => streams.delete(stop))
        return
      }

      return fail(res, 404, 'NOT_FOUND', 'No such panel endpoint', options)
    } catch (error) {
      if (error instanceof CollabError && error.code === CODES.NOT_FOUND) return fail(res, 404, error.code, error.message, options)
      if (isUninitialised(error)) return fail(res, 409, error.code, error.message, options)
      return fail(res, 500, error.code || 'INTERNAL_ERROR', error.message || 'The panel could not read this view', options)
    }
  }

  server = createServer((req, res) => void handler(req, res))
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/?t=${encodeURIComponent(token)}`
  let closing = null
  const close = () => {
    if (closing) return closing
    for (const stop of streams) stop()
    streams.clear()
    closing = new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
    server.closeAllConnections?.()
    return closing
  }
  return { server, url, close }
}
