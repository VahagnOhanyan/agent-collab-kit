import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODES, CollabError } from '../collab/src/errors.mjs'
import { ownerCloseTasks, ownerReopenTask } from '../collab/src/domain/owner.mjs'
import { describeProject, isUninitialised } from '../collab/src/api.mjs'
import { cleanupTask, readBacklog, recordsWord, suggestedRole } from '../collab/src/backlog.mjs'
import { listProjects } from '../collab/src/projects.mjs'
import { unadaptedVendors } from '../collab/src/vendors.mjs'
import { readKitFiles } from './kit-files.mjs'
import { applySetup, detectSetup, previewSetup, revertSetup } from './setup-wizard.mjs'
import { eventsView, overviewView, rosterView, setupCheckView, tasksView, taskView, waitingView } from './views.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_ROOT = realpathSync(join(HERE, 'public'))
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
const MIME = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const SAFE_METHODS = new Set(['GET', 'HEAD'])
// What the panel writes: the machine composition (the wizard), a backlog cleanup task, and the owner closing or
// reopening tasks (collab/src/domain/owner.mjs). Every one only from a panel started at the owner's terminal.
const WRITE_PATHS = new Set(['/api/setup/apply', '/api/setup/revert', '/api/backlog/cleanup', '/api/tasks/close', '/api/tasks/reopen'])
// Room for closing a few hundred tasks at once (an id is ~20 bytes) plus the reason; still a small, bounded read.
const WRITE_BODY_MAX = 16384
const APPLY_KEYS = new Set(['agents', 'lead', 'single_vendor', 'roles', 'confirmed', 'owner_language', 'expect'])
const PREVIEW_KEYS = new Set(['agents', 'lead', 'single_vendor', 'roles', 'confirmed', 'owner_language', 't', 'project'])
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MACHINE_SCREENS = new Set(['/api/kit', '/api/vendors', '/api/setup/detect', '/api/projects', '/api/panel'])
const ROLES_PARAM_MAX = 2048

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

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > WRITE_BODY_MAX) throw Object.assign(new Error('The request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('The request body is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The request body must be a JSON object')
  return parsed
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
  clock = null,
  allowWrite = false,
  // How the machine's facts are read (collab/src/probe.mjs machineEnv): tests describe a machine, the CLI reads this one.
  probeEnv = undefined,
  // A journal API that can write, for the one journal write the panel makes (a backlog cleanup task). Used only when
  // allowWrite holds; without it that write is refused.
  writeApiFactory = null,
  // Known vendor CLIs on this machine without an adapter (collab/src/vendors.mjs); tests pass their own lookup.
  vendorsLookup = unadaptedVendors
} = {}) {
  if (host !== '127.0.0.1') throw new CollabError(CODES.INVALID_INPUT, 'the panel only listens on 127.0.0.1')
  if (typeof token !== 'string' || token.length < 16) throw new CollabError(CODES.INVALID_INPUT, 'the panel needs a random token')
  if (typeof apiFactory !== 'function') throw new CollabError(CODES.INVALID_INPUT, 'the panel needs an apiFactory')

  // ── which project's journal a request reads (the switcher, 01.10.2026) ───────
  // `?project=<id>` names a project of the trusted registry — nothing else: an id the registry does not hold, an entry
  // with problems or one with no root on this machine is refused, so a request can never point the panel at an
  // arbitrary directory. No parameter: the project the panel was started in, as before.
  const registryProjects = () => (registryDir ? listProjects(registryDir) : []).filter((entry) => entry.problems.length === 0)
  const resolveProject = (url) => {
    const values = url.searchParams.getAll('project')
    // A repeated parameter is refused before anything else: `?project=&project=beta` must not read as "none".
    if (values.length > 1) return { error: [400, 'INVALID_INPUT', 'project is given at most once'] }
    if (!values.length || values[0] === '') return { where: null }
    if (!PROJECT_ID.test(values[0])) return { error: [400, 'INVALID_INPUT', 'project is one registry project id'] }
    const entry = registryProjects().find((project) => project.id === values[0])
    if (!entry) return { error: [404, 'NOT_FOUND', `No connected project "${values[0]}" in the registry`] }
    const index = entry.realRoots.findIndex((root) => existsSync(root))
    if (index === -1) return { error: [404, 'NOT_FOUND', `Project "${values[0]}" has no root on this machine`] }
    return { where: { id: entry.id, cwd: entry.realRoots[index], projectRoot: entry.roots[index] } }
  }
  const cwdOf = (where) => where?.cwd || cwd
  // A factory written for one journal (tests, an older caller) takes no argument and simply ignores the project.
  const apiFor = (where) => (where ? apiFactory(where) : apiFactory())
  const writeApiFor = (where) => (where ? writeApiFactory(where) : writeApiFactory())

  // The project's backlog of small review findings, grouped by feature (collab/src/backlog.mjs). Settings come only
  // from the trusted registry entry of the selected project.
  const backlogFor = async (api, where = null) => {
    const project = describeProject({ cwd: cwdOf(where), ...(registryDir ? { registryDir } : {}) })
    const projectDir = project.projectId ? join(project.registryDir, project.projectId) : null
    const openTasks = api ? await api.listTasks({ open: true }) : []
    const view = readBacklog({ projectDir, projectRoot: project.journalRoot, openTasks })
    const held = api ? Object.keys(api.registry.roles()).filter((role) => api.registry.find({ role }).length) : []
    return { ...view, roles: held, groups: view.groups.map((group) => ({ ...group, role: suggestedRole(group), count_label: `${group.count} ${recordsWord(group.count)}` })) }
  }

  // One task for one feature's records, from what the owner saw (`expect`, the backlog file's fingerprint); never a
  // second one while the first is open; the role must have a holder. The backlog file itself is not touched.
  // Two requests for the same group at once (two tabs, a double submit) must not both pass the "no open cleanup"
  // check: creations from this panel run one after the other.
  let cleanupQueue = Promise.resolve()
  const createCleanup = (api, input, where = null) => {
    const run = cleanupQueue.then(() => createCleanupNow(api, input, where))
    cleanupQueue = run.catch(() => {})
    return run
  }
  const createCleanupNow = async (api, { feature, role, expect }, where = null) => {
    const view = await backlogFor(api, where)
    if (!view.configured) return { ok: false, reason: view.reason }
    if (expect !== view.expect) return { ok: false, reason: 'Бэклог изменился, пока вы смотрели. Обновите страницу.' }
    const group = view.groups.find((g) => g.feature === feature)
    if (!group) return { ok: false, reason: `В бэклоге нет группы «${feature}».` }
    if (group.cleanup) return { ok: false, reason: `Уборка по «${feature}» уже заведена: ${group.cleanup.id} (${group.cleanup.status}).` }
    if (!view.roles.includes(role)) return { ok: false, reason: `Роль ${role} никто не держит — задачу на неё никто не возьмёт.` }
    const draft = cleanupTask(group, view.file)
    const task = await api.createTask({ ...draft, role })
    return { ok: true, task: { id: task.id, title: task.title, role: task.role } }
  }

  // After the set of agents changed: tasks of an agent taken out go, in THIS project's journal, to one that holds the
  // role (collab domain handOverFromAbsent). Other projects get it when a session opens there. Never fails the write
  // that already succeeded: no journal here, no right to write it, an error — the answer says so.
  const handOverHere = async (changes = [], where = null) => {
    if (!changes.some((change) => change.field === 'agents')) return null
    const later = 'collab попробует снова при следующих сессиях агентов в проекте; если журнал недоступен для записи, его задачи останутся за исключённым агентом, пока вы не передадите их вручную (collab task / release).'
    if (typeof writeApiFactory !== 'function') return { done: false, reason: `Панель не пишет в журнал проекта. ${later}` }
    try {
      return { done: true, ...(await (await writeApiFor(where)).handOverFromAbsent()) }
    } catch (error) {
      return { done: false, reason: `Задачи в этом проекте сейчас не переданы (${error.message}). ${later}` }
    }
  }
  // For the preview: how many open tasks each agent about to be taken out holds in this project's journal.
  const openTasksOf = async (ids = [], where = null) => {
    if (!ids.length) return {}
    try {
      const open = await (await apiFor(where)).listTasks({ open: true })
      return Object.fromEntries(ids.map((id) => [id, open.filter((task) => task.owner === id).length]))
    } catch {
      return {}
    }
  }

  const streams = new Set()
  const envSecrets = Object.values(process.env).filter((value) => typeof value === 'string' && value.length >= 8)
  const secrets = [token, homedir(), ...envSecrets]
  let server

  const handler = async (req, res) => {
    const address = server.address()
    const expectedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
    const options = { head: req.method === 'HEAD', secrets }
    if (!expectedHosts.has(req.headers.host || '')) return fail(res, 403, 'FORBIDDEN_HOST', 'Host is not the local panel address', options)
    const writing = req.method === 'POST' && WRITE_PATHS.has((req.url || '').split('?')[0])
    if (!SAFE_METHODS.has(req.method) && !writing) return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', { ...options, headers: { Allow: 'GET, HEAD' } })

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
    const chosen = resolveProject(url)
    // Screens of the machine (kit, vendors, the wizard's detection) and the switcher's own list do not depend on the
    // project: a project chosen and then disconnected must not take them down — the list must stay usable to choose
    // another. Every journal screen refuses an unusable choice instead of silently reading another journal.
    const machineScreen = MACHINE_SCREENS.has(url.pathname)
    if (chosen.error && !machineScreen) return fail(res, chosen.error[0], chosen.error[1], chosen.error[2], options)
    const where = machineScreen && url.pathname !== '/api/projects' ? null : chosen.where || null

    if (writing) {
      // A write is driven by the panel's own page and by nothing else: the browser must say so (same-origin, not
      // "none" — a typed address — and not silence), name this origin, and send JSON, which a form cannot.
      if (!allowWrite) return fail(res, 403, 'READ_ONLY', 'This panel was started without the right to write', options)
      if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers.origin !== `http://${req.headers.host}`) {
        return fail(res, 403, 'FORBIDDEN_ORIGIN', 'A write must come from the panel page itself', options)
      }
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'A write must be application/json', options)
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return fail(res, error.status || 400, 'INVALID_INPUT', error.message, options)
      }
      // A failure inside a write is an answer, never a crash of the panel.
      try {
        // The owner closing tasks (one or a batch, all or nothing) or reopening one. The reason is required by the domain.
        if (url.pathname === '/api/tasks/close' || url.pathname === '/api/tasks/reopen') {
          if (typeof writeApiFactory !== 'function') return fail(res, 403, 'READ_ONLY', 'This panel cannot change tasks', options)
          const closing = url.pathname === '/api/tasks/close'
          const keys = closing ? ['task_ids', 'outcome', 'reason'] : ['task_id', 'reason']
          const badShape = Object.keys(body).some((key) => !keys.includes(key)) || typeof body.reason !== 'string' ||
            (closing ? !Array.isArray(body.task_ids) || !body.task_ids.every((id) => typeof id === 'string') || body.task_ids.length > 500 || typeof body.outcome !== 'string' : typeof body.task_id !== 'string')
          if (badShape) return fail(res, 400, 'INVALID_INPUT', closing ? 'task_ids, outcome and reason are each required, and nothing else' : 'task_id and reason are each required, and nothing else', options)
          const ctx = (await writeApiFor(where)).ctx
          try {
            const done = closing
              ? await ownerCloseTasks(ctx, { task_ids: body.task_ids, outcome: body.outcome, reason: body.reason })
              : await ownerReopenTask(ctx, { task_id: body.task_id, reason: body.reason })
            return sendJson(res, 200, { ok: true, ...done }, { ...options, headers: authHeaders })
          } catch (error) {
            if (error instanceof CollabError) return sendJson(res, 409, { ok: false, reason: error.message }, { ...options, headers: authHeaders })
            throw error
          }
        }
        if (url.pathname === '/api/backlog/cleanup') {
          if (Object.keys(body).some((key) => !['feature', 'role', 'expect'].includes(key)) || typeof body.feature !== 'string' || typeof body.role !== 'string' || typeof body.expect !== 'string') {
            return fail(res, 400, 'INVALID_INPUT', 'feature, role and expect are each required, and nothing else', options)
          }
          if (typeof writeApiFactory !== 'function') return fail(res, 403, 'READ_ONLY', 'This panel cannot create tasks', options)
          const created = await createCleanup(await writeApiFor(where), body, where)
          return sendJson(res, created.ok ? 200 : 409, created, { ...options, headers: authHeaders })
        }
        if (url.pathname === '/api/setup/revert') {
          if (Object.keys(body).some((key) => key !== 'expect') || typeof body.expect !== 'string') return fail(res, 400, 'INVALID_INPUT', 'Revert takes exactly expect', options)
          const undone = revertSetup({ expect: body.expect, machineDir, env: probeEnv })
          if (undone.ok) undone.handover = await handOverHere(undone.changes, where)
          return sendJson(res, undone.ok ? 200 : 409, undone, { ...options, headers: authHeaders })
        }
        if (Object.keys(body).some((key) => !APPLY_KEYS.has(key))) return fail(res, 400, 'INVALID_INPUT', 'Only agents, lead, single_vendor, roles, confirmed, owner_language and expect are accepted', options)
        if (body.owner_language !== undefined && typeof body.owner_language !== 'string') return fail(res, 400, 'INVALID_INPUT', 'owner_language, when given, is a language code or an empty string', options)
        if (!Array.isArray(body.agents) || typeof body.lead !== 'string' || typeof body.single_vendor !== 'boolean' || typeof body.expect !== 'string') {
          return fail(res, 400, 'INVALID_INPUT', 'agents (list), lead, single_vendor (boolean) and expect are each required', options)
        }
        for (const field of ['roles', 'confirmed']) {
          if (body[field] !== undefined && (!body[field] || typeof body[field] !== 'object' || Array.isArray(body[field]))) {
            return fail(res, 400, 'INVALID_INPUT', `${field}, when given, is an object of agent id to a list`, options)
          }
        }
        const applied = applySetup({ agents: body.agents, lead: body.lead, singleVendor: body.single_vendor, roles: body.roles ?? null, confirmed: body.confirmed ?? null, ownerLanguage: body.owner_language, expect: body.expect, machineDir, env: probeEnv })
        if (applied.ok) applied.handover = await handOverHere(applied.changes, where)
        return sendJson(res, applied.ok ? 200 : 409, applied, { ...options, headers: authHeaders })
      } catch (error) {
        return fail(res, 500, 'WRITE_FAILED', `The write failed and nothing was reported as done: ${error.message}`, options)
      }
    }

    try {
      if (url.pathname === '/api/setup/detect') {
        return sendJson(res, 200, { ...detectSetup({ registryDir, machineDir, cwd }), writable: allowWrite }, { ...options, headers: authHeaders })
      }
      if (url.pathname === '/api/setup/preview') {
        if ([...url.searchParams.keys()].some((key) => !PREVIEW_KEYS.has(key))) {
          return fail(res, 400, 'INVALID_INPUT', 'Only agents, lead, single_vendor, roles, confirmed and owner_language are accepted', options)
        }
        // roles and confirmed: each at most once, short, a JSON object of agent id to a list.
        const objectParam = (name) => {
          const values = url.searchParams.getAll(name)
          if (values.length > 1 || (values[0] || '').length > ROLES_PARAM_MAX) return { error: `${name} is given at most once and is short` }
          if (!values.length) return { value: null }
          let parsed
          try {
            parsed = JSON.parse(values[0])
          } catch {
            return { error: `${name} must be JSON` }
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: `${name} is an object of agent id to a list` }
          return { value: parsed }
        }
        const rolesParam = objectParam('roles')
        const confirmedParam = objectParam('confirmed')
        const paramError = rolesParam.error || confirmedParam.error
        if (paramError) return fail(res, 400, 'INVALID_INPUT', paramError, options)
        const roles = rolesParam.value
        const agentsValues = url.searchParams.getAll('agents')
        const leadValues = url.searchParams.getAll('lead')
        const vendorValues = url.searchParams.getAll('single_vendor')
        if (agentsValues.length !== 1 || leadValues.length !== 1 || vendorValues.length !== 1) {
          return fail(res, 400, 'INVALID_INPUT', 'agents, lead and single_vendor are each required once', options)
        }
        const languageValues = url.searchParams.getAll('owner_language')
        if (languageValues.length > 1 || (languageValues[0] || '').length > 16) return fail(res, 400, 'INVALID_INPUT', 'owner_language is given at most once and is short', options)
        const answer = previewSetup({
          agents: agentsValues[0].split(',').filter(Boolean),
          lead: leadValues[0],
          singleVendor: vendorValues[0],
          env: probeEnv,
          roles,
          confirmed: confirmedParam.value,
          ownerLanguage: languageValues.length ? languageValues[0] : undefined,
          registryDir,
          machineDir,
          cwd
        })
        if (answer.apply?.removed_agents?.length) answer.apply.removed_tasks = await openTasksOf(answer.apply.removed_agents, where)
        // A project with its own composition (registry entry collab/agents.json) replaces the machine's: the wizard's
        // ticks change the machine and do not reach that project. Said, not hidden.
        const here = describeProject({ cwd: cwdOf(where), ...(registryDir ? { registryDir } : {}) })
        if (here.projectId && existsSync(join(here.registryDir, here.projectId, 'collab', 'agents.json'))) answer.project_own_composition = here.projectId
        return sendJson(res, 200, answer, { ...options, headers: authHeaders })
      }
      if (url.pathname === '/api/kit') return sendJson(res, 200, readKitFiles(kitRoot), { ...options, headers: authHeaders })
      // Read-only: a PATH lookup, no CLI is started.
      if (url.pathname === '/api/vendors') return sendJson(res, 200, { unadapted: await vendorsLookup() }, { ...options, headers: authHeaders })
      // The switcher's list: the connected projects of the trusted registry, whether each has a journal yet, and which
      // one the panel was started in (shown when nothing is chosen).
      // What this panel may do: the page shows write controls (close/reopen tasks) only when the answer is yes.
      if (url.pathname === '/api/panel') return sendJson(res, 200, { writable: allowWrite && typeof writeApiFactory === 'function' }, { ...options, headers: authHeaders })
      if (url.pathname === '/api/projects') {
        const started = describeProject({ cwd, ...(registryDir ? { registryDir } : {}) })
        // No root in the answer: the page does not need it, and a root outside the home would not be scrubbed.
        const list = registryProjects().map((entry) => {
          const index = entry.realRoots.findIndex((root) => existsSync(root))
          const root = index === -1 ? null : entry.realRoots[index]
          const described = root ? describeProject({ cwd: root, ...(registryDir ? { registryDir } : {}) }) : null
          return { id: entry.id, present: Boolean(root), initialized: Boolean(described?.initialized) }
        })
        return sendJson(res, 200, {
          projects: list,
          // null: the panel was started in a folder that is not a connected project — the page lists it as such.
          started: started.projectId || null,
          selected: chosen.error ? null : where?.id || started.projectId || null,
          // The chosen project cannot be used any more (disconnected, no root here): said, so another can be chosen.
          unusable: chosen.error ? chosen.error[2] : null
        }, { ...options, headers: authHeaders })
      }

      let api
      try {
        api = await apiFor(where)
      } catch (error) {
        if (isUninitialised(error) && url.pathname === '/api/overview') {
          return sendJson(res, 200, initHint(cwdOf(where)), { ...options, headers: authHeaders })
        }
        throw error
      }

      if (url.pathname === '/api/overview') return sendJson(res, 200, await overviewView(api), { ...options, headers: authHeaders })
      if (url.pathname === '/api/backlog') return sendJson(res, 200, { ...(await backlogFor(api, where)), writable: allowWrite && typeof writeApiFactory === 'function' }, { ...options, headers: authHeaders })
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
