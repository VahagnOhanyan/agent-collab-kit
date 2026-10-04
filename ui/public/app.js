// Agent Collab Kit panel: read-only views over the collab journal and the kit files.
// Everything the journal contains was written by agents, so it is untrusted:
// every value goes into the page through textContent, never as markup.
'use strict'

const main = document.getElementById('main')
const toastBox = document.getElementById('toast')
let toastTimer = null
let routeSeq = 0 // bumped on every navigation; a slower, older screen must not overwrite a newer one

// ── helpers ───────────────────────────────────────────────────────────────
function el(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

// The first visit carries ?t=<token>. It lives in this tab's sessionStorage and goes out as a header, never as a
// cookie: a browser sends cookies to every port of 127.0.0.1, so any other local service would receive it.
const PANEL_TOKEN = (() => {
  const fromUrl = new URL(location.href).searchParams.get('t')
  try {
    if (fromUrl) sessionStorage.setItem('panel_token', fromUrl)
    return fromUrl || sessionStorage.getItem('panel_token') || ''
  } catch {
    return fromUrl || ''
  }
})()

// The project whose journal the panel shows: `?project=<id>` in the address (so a link opens the same project), chosen
// in the switcher. Empty: the project the panel was started in. Every request carries it; the server resolves it from
// the trusted registry and refuses anything else.
const PROJECT = new URL(location.href).searchParams.get('project') || ''
function withProject(path) {
  if (!PROJECT) return path
  const url = new URL(path, location.origin)
  url.searchParams.set('project', PROJECT)
  return url.pathname + url.search
}

async function api(path) {
  const response = await fetch(withProject(path), { credentials: 'omit', headers: { accept: 'application/json', 'x-panel-token': PANEL_TOKEN } })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const message = body?.error?.message || `HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.code = body?.error?.code
    throw error
  }
  return body
}

// The only write the panel makes. `credentials: 'omit'`, the token as a header and a JSON body: the server accepts
// nothing else (see the write checks in server.mjs).
async function post(path, body) {
  const response = await fetch(withProject(path), {
    method: 'POST',
    credentials: 'omit',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-panel-token': PANEL_TOKEN },
    body: JSON.stringify(body)
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) throw new Error(payload?.reason || payload?.error?.message || `HTTP ${response.status}`)
  return payload
}

function toast(text) {
  toastBox.textContent = text
  toastBox.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastBox.hidden = true }, 1800)
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Скопировано')
  } catch {
    toast('Не удалось скопировать: выделите текст вручную')
  }
}

const STATUS_TONE = {
  completed: 'ok', approved: 'ok', available: 'ok', granted: 'ok',
  blocked: 'bad', failed: 'bad', rejected: 'bad', offline: 'muted',
  changes_requested: 'warn', waiting_for_user: 'warn', waiting_for_agent: 'warn', pending: 'warn', busy: 'warn', waiting: 'warn',
  in_progress: 'info', review: 'info', running: 'info', cancelled: 'muted', released: 'muted'
}
// Values the ledger stores as English words are shown in Russian; the raw value
// stays in the tooltip, because it is what the terminal commands and logs use.
const STATUS_RU = {
  completed: 'завершена', cancelled: 'отменена', created: 'создана', approved: 'одобрена', changes_requested: 'нужны правки',
  blocked: 'заблокирована', waiting_for_user: 'ждёт вас', waiting_for_agent: 'ждёт агента', in_progress: 'в работе', review: 'на ревью',
  pending: 'ожидает', available: 'доступен', offline: 'не в сети', busy: 'занят', waiting: 'ждёт', failed: 'упало', granted: 'выдано',
  rejected: 'отклонено', released: 'снято', denied: 'отклонено', open: 'открыто', disputed: 'спор', escalated: 'передано владельцу', decided: 'решено', resolved: 'решено'
}
// Why an unfinished task is still unfinished (computed by the panel server, never stored).
const STANDSTILL_RU = {
  not_started: 'не начата', blocked: 'заблокирована', review_changes: 'правки по ревью', awaiting_approval: 'ждёт одобрения',
  approval_expired: 'одобрение просрочено', ready_to_complete: 'можно закрывать', ux_gate: 'нужно UX-ревью',
  in_review: 'ждёт ревью', in_work: 'в работе', waiting_agent: 'ждёт агента'
}
const STANDSTILL_TONE = {
  blocked: 'bad', approval_expired: 'bad', review_changes: 'warn', awaiting_approval: 'warn', ux_gate: 'warn',
  ready_to_complete: 'ok', in_work: 'muted'
}
const standstillPill = (s) => el('span', { class: `pill ${STANDSTILL_TONE[s.code] || ''}`, title: s.code, text: STANDSTILL_RU[s.code] || s.code })
// What a review checks (reviews.mjs SLOTS) and how a check ended (runs.mjs).
const SLOT_RU = {
  requirements: 'ревью требований', architecture: 'ревью архитектуры', implementation: 'ревью реализации', tests: 'ревью тестов',
  ui: 'ревью интерфейса', consistency: 'ревью согласованности', security: 'ревью безопасности', challenger: 'оппонент'
}
const slotText = (r) => SLOT_RU[r.slot] || (r.slot ? `ревью: ${r.slot}` : 'ревью')
const RUN_RU = { passed: 'прошла', failed: 'упала', timeout: 'не уложилась во время', nothing_ran: 'ничего не запустилось', running: 'идёт', queued: 'в очереди', error: 'ошибка' }
const RUN_TONE = { passed: 'ok', failed: 'bad', timeout: 'bad', nothing_ran: 'bad', error: 'bad', running: 'warn', queued: 'warn' }
const runPill = (status) => el('span', { class: `pill ${RUN_TONE[status] || ''}`, title: status ?? '', text: RUN_RU[status] || status || '—' })
const REVIEW_MODE_RU ={ cross_vendor: 'ревью другим вендором', single_vendor: 'ревью тем же вендором' }
const LANGUAGE_RU = { ru: 'русский', en: 'английский' }
const statusText = (status) => (status === undefined || status === null ? '—' : STATUS_RU[status] || status)
const pill = (status) => el('span', { class: `pill ${STATUS_TONE[status] || ''}`, title: status ?? '', text: statusText(status) })
// The journal stores UTC; the owner reads local time ("1 окт., 10:04"), the year only when it is not this one.
const when = (iso, { seconds = false } = {}) => {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return iso ? String(iso) : '—'
  return date.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {})
  })
}
const chips = (list) => el('div', { class: 'chips' }, (list || []).map((item) => el('span', { class: 'pill', text: item })))
// Every copy button says WHAT it copies: a screen reader lists buttons out of
// context, and four of them named just "Копировать" cannot be told apart.
const command = (text, purpose = 'команду') =>
  el('div', { class: 'cmd' }, el('code', { text }), el('button', { type: 'button', 'aria-label': `Копировать ${purpose}`, onclick: () => copy(text), text: 'Копировать' }))

// Known vendor CLIs on this machine without an adapter (skill vendor-probe): found by a PATH lookup only. Nothing is
// started from here — the owner gives the sentence to that agent (or to the lead), and it asks before any paid call.
async function vendorsNotice() {
  const data = await api('/api/vendors').catch(() => null)
  const list = data?.unadapted || []
  if (!list.length) return null
  return el('div', { class: 'note warn' },
    el('strong', { text: `Найден${list.length > 1 ? 'ы агенты' : ' агент'} без адаптера — collab с ${list.length > 1 ? 'ними' : 'ним'} пока не работает` }),
    ...list.map((v) => el('div', {},
      el('div', { text: `${v.binary} (${v.vendor}) · ${v.path}` }),
      // Connected by the installer's own client (agy → gemini): reconnaissance would lead nowhere, so no phrase.
      v.advice
        ? el('div', { class: 'muted', text: v.advice })
        : [el('div', { class: 'muted', text: 'Чтобы подготовить адаптер, скажите этому агенту — или своему ведущему — фразу ниже. Разведка идёт в песочнице, платный вызов только после вашего «да».' }),
            command(v.phrase, `фразу для ${v.binary}`)])))
}

function page(title, subtitle, ...content) {
  return [el('h1', { text: title }), subtitle ? el('p', { class: 'sub', text: subtitle }) : null, ...content]
}
const empty = (text) => el('div', { class: 'empty', text })

// Every list of records is a table with named columns: one value per column, never three fields packed in one.
// td(content, 'nw') is a narrow column that does not wrap (status, model, date); the rest share the width.
const td = (content, cls) => el('td', cls ? { class: cls } : {}, content)
const dataTable = (heads, rows) => el('table', { class: 'data' },
  el('thead', {}, el('tr', {}, heads.map((h) => el('th', { text: h })))),
  el('tbody', {}, rows))
// A row that opens a page: the whole row is clickable, and the link inside it keeps the keyboard and the middle click.
const linkRow = (href, cells) => el('tr', { class: 'link', onclick: (e) => { if (!e.target.closest('a, input, label, td.check')) location.hash = href.replace(/^#/, '') } }, cells)

// Whether this panel may write (started from the owner's terminal): asked once, and the write controls are drawn only
// when it may — a read-only panel shows no button that would only fail.
let writableOnce = null
const panelWritable = () => (writableOnce ||= api('/api/panel').then((d) => Boolean(d.writable)).catch(() => false))

// The owner closing or reopening tasks (collab/src/domain/owner.mjs): a reason is required — without one nothing is
// sent — and the button inside the form is the second, deliberate click.
function ownerForm({ title, lines = [], warning = null, confirmText, onConfirm, onCancel }) {
  const reason = el('textarea', { rows: '2', placeholder: 'Причина — обязательно', 'aria-label': 'Причина' })
  const error = el('div', { class: 'note bad', hidden: true })
  const ok = el('button', { type: 'button', class: 'primary', text: confirmText, onclick: async () => {
    const text = reason.value.trim()
    if (!text) {
      error.textContent = 'Напишите причину: без неё действие не выполняется.'
      error.hidden = false
      reason.focus()
      return
    }
    ok.disabled = true
    try {
      await onConfirm(text)
    } catch (failure) {
      error.textContent = failure.message
      error.hidden = false
      ok.disabled = false
    }
  } })
  const box = el('div', { class: 'card owner-form' }, el('strong', { text: title }),
    lines.map((line) => el('div', { class: 'muted small', text: line })),
    warning ? el('div', { class: 'note warn', text: warning }) : null,
    reason, error,
    el('div', { class: 'toolbar' }, ok, el('button', { type: 'button', text: 'Отмена', onclick: onCancel })))
  setTimeout(() => reason.focus(), 0)
  return box
}
const OWNER_CLOSE_LINES = [
  'Ждущие ревью по задаче снимаются, поручения субагентам без итога закрываются, ждущее одобрение отклоняется.',
  'Исполнителю придёт письмо с вашей причиной; в задаче останется пометка «закрыта владельцем».'
]
const OWNER_OUTCOME_RU = { completed: 'завершена', cancelled: 'отменена' }
// The note a closed-by-owner task carries, on its page and in the list.
const ownerClosedNote = (c) => `${OWNER_OUTCOME_RU[c.outcome] || c.outcome} владельцем ${when(c.at)} (была «${statusText(c.from_status)}»): ${c.reason}`

function failure(error) {
  if (error.status === 403) {
    return [el('h1', { text: 'Нет доступа' }), el('p', { class: 'sub', text: 'Откройте панель по адресу, который напечатала команда collab ui (в нём есть токен).' })]
  }
  return [el('h1', { text: 'Не получилось загрузить' }), el('div', { class: 'note bad', text: error.message })]
}

function uninitialised(hint) {
  return [
    el('div', { class: 'note warn', text: 'В этом проекте нет журнала коллаборации.' }),
    hint?.command ? el('p', { class: 'sub', text: `Создать его можно в терминале${hint.run_in ? ` (каталог ${hint.run_in})` : ''}:` }) : null,
    hint?.command ? command(hint.command) : null
  ]
}

// Unfinished delegations on open tasks. A delegation is not a task: it is the lead's note that a piece of a task went
// to a subagent, closed with the subagent's outcome. So they are grouped under the task they belong to, and one left
// open for more than a day is called what it almost always is — a note nobody closed, not work in progress.
const DAY_MS = 24 * 60 * 60 * 1000
function delegationsBlock(list) {
  const byTask = new Map()
  for (const d of list) {
    if (!byTask.has(d.task_id)) byTask.set(d.task_id, { id: d.task_id, title: d.task_title, status: d.task_status, items: [] })
    byTask.get(d.task_id).items.push(d)
  }
  const latest = (g) => g.items.reduce((m, d) => (String(d.started_at || '') > m ? String(d.started_at || '') : m), '')
  const groups = [...byTask.values()].sort((a, b) => latest(b).localeCompare(latest(a)))
  const age = (d) => (d.started_at ? Date.now() - new Date(d.started_at).getTime() : 0)
  const row = (d) => el('tr', {},
    td(el('span', { class: 'mono', text: d.to }), 'nw'), td(el('span', { class: 'pill', text: `${d.model}${d.level ? ` · ${d.level}` : ''}` }), 'nw'),
    td(d.purpose || ''),
    td(age(d) > DAY_MS ? el('span', { class: 'pill warn', title: `Отдано ${when(d.started_at)}`, text: `не закрыто ${Math.floor(age(d) / DAY_MS)} дн.` }) : el('span', { class: 'muted small', text: when(d.started_at) }), 'nw'))
  return [
    el('h2', { text: 'Поручения субагентам без итога' }),
    el('p', { class: 'sub', text: `${list.length} ${list.length === 1 ? 'поручение' : 'поручений'} в ${groups.length} ${groups.length === 1 ? 'задаче' : 'задачах'}. Поручение — не задача: это запись ведущего, что часть задачи отдана субагенту; она закрывается итогом субагента. Старые незакрытые почти всегда просто забыли закрыть.` }),
    ...groups.map((g) => el('div', { class: 'card' },
      el('div', { class: 'row' }, pill(g.status), el('a', { class: 'grow', href: `#/tasks/${encodeURIComponent(g.id)}`, text: g.title || g.id }),
        el('span', { class: 'muted small', text: `${g.items.length} без итога` })),
      dataTable(['Кому', 'Модель', 'Поручение', 'Отдано'], [...g.items].sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))).map(row))))]
}

// ── screens ───────────────────────────────────────────────────────────────
async function overview() {
  const data = await api('/api/overview')
  const connect = await connectHint()
  if (!data.initialized) return page('Обзор', 'Журнал не найден', connect, uninitialised(data.hint))
  const s = data.status
  // status() counts every pending approval; an expired one can no longer be
  // granted, so it is shown apart instead of inflating "waiting for you".
  const waitingNow = await api('/api/waiting').catch(() => null)
  const known = Boolean(waitingNow) // if it failed the split is unknown; say so, do not guess zero
  const vendors = await vendorsNotice()
  const expired = (waitingNow?.approvals || []).filter((a) => a.expired).length
  // Both numbers from one snapshot: status() and /api/waiting are read at different moments.
  const live = known ? (waitingNow.approvals || []).length - expired : s.approvals_pending
  // A tile that has a screen behind it is a link to it: the numbers the owner
  // must act on (approvals, decisions) should not need a second hunt in the menu.
  const tile = (n, label, hot, href) =>
    el(href ? 'a' : 'div', { class: `tile${hot ? ' hot' : ''}${href ? ' link' : ''}`, href }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: label }))
  const problems = [
    ...(data.doctor?.problems || []),
    ...(data.doctor?.orphaned_tasks || []).map((t) => `Задача ${t.id} ждёт роль ${t.role}, которой ни у кого нет, и никем не будет взята: ${t.title}`),
    // A role an agent suspended itself: the owner gives it back in the terminal, or takes it away in the wizard.
    ...(data.doctor?.suspended_roles || []).map((s) => `${s.agent} приостановил роль ${s.role}: ${s.reason}. Вернуть: ${s.restore}. Отобрать насовсем: снимите роль в мастере настройки.`)
  ]
  return page(
    'Обзор',
    s.journal_root || data.journal_root,
    connect,
    el('div', { class: 'grid' },
      tile(s.tasks.open, 'открытых задач', false, '#/tasks'),
      known
        ? tile(live, 'ждут вашего одобрения', live > 0, '#/waiting')
        : tile(s.approvals_pending, 'ждут одобрения (часть может быть просрочена: не удалось проверить)', s.approvals_pending > 0, '#/waiting'),
      tile(s.decisions_open, 'вопросов ждут вашего выбора', s.decisions_open > 0, '#/waiting'),
      tile(s.reviews_pending, 'ревью в очереди', false, '#/waiting'),
      tile(s.runs_failed, 'проверок не проходят сейчас', s.runs_failed > 0)),
    vendors,
    el('h2', { text: 'Агенты' }),
    dataTable(['Статус', 'Агент', 'Текущая задача'], s.agents.map((a) => el('tr', {},
      td(pill(a.status), 'nw'), td(el('strong', { text: a.id }), 'nw'),
      td(a.current_task_id ? el('a', { href: `#/tasks/${encodeURIComponent(a.current_task_id)}`, class: 'mono', text: a.current_task_id }) : el('span', { class: 'muted', text: '—' }))))),
    el('h2', { text: 'Задачи по статусам' }),
    Object.keys(s.tasks.by_status).length
      ? el('div', { class: 'chips' }, Object.entries(s.tasks.by_status).map(([k, v]) => el('a', { class: `pill ${STATUS_TONE[k] || ''}`, href: `#/tasks?status=${encodeURIComponent(k)}`, title: `Открыть задачи со статусом «${statusText(k)}»`, text: `${statusText(k)}  ${v}` })))
      : empty('Задач пока нет'),
    s.delegations?.length ? delegationsBlock(s.delegations) : null,
    el('h2', { text: 'Рабочее дерево' }),
    s.git?.is_git
      ? el('div', { class: 'card' },
          el('div', { class: 'mono', text: `${s.git.branch} @ ${s.git.head} · ${s.git.dirty_files} изменённых файлов` }),
          s.git.unclaimed_dirty?.length ? el('div', { class: 'note warn', text: `${s.git.unclaimed_dirty.length} файлов не закреплено ни за одной задачей: проверьте, чьи они, до коммита` }) : null)
      : empty('Не git-репозиторий'),
    problems.length ? [el('h2', { text: 'Диагностика' }), problems.map((p) => el('div', { class: 'note warn', text: typeof p === 'string' ? p : JSON.stringify(p) }))] : null
  )
}

async function tasks(param) {
  if (param) return taskDetail(param)
  const params = new URLSearchParams(location.hash.split('?')[1] || '')
  const all = params.get('all') === '1'
  const status = params.get('status') || ''
  // Every task is read once; the filter — open, all, or one status (the same chips as on the overview) — is applied
  // here, so each chip can say how many it holds.
  const everything = await api('/api/tasks')
  const isOpen = (t) => !TERMINAL.has(t.status)
  const shown = status ? everything.filter((t) => t.status === status) : all ? everything : everything.filter(isOpen)
  // A task created within another sits under it, indented, when both are on the screen; one whose parent is filtered
  // out stands alone and says where it came from. Order within a level is the list's own.
  const depthOf = new Map()
  const list = []
  {
    const ids = new Set(shown.map((t) => t.id))
    const kids = new Map()
    for (const t of shown) if (t.parent_task && ids.has(t.parent_task)) kids.set(t.parent_task, [...(kids.get(t.parent_task) || []), t])
    const walk = (t, depth) => {
      if (depthOf.has(t.id)) return
      depthOf.set(t.id, depth)
      list.push(t)
      for (const child of kids.get(t.id) || []) walk(child, depth + 1)
    }
    for (const t of shown) if (!(t.parent_task && ids.has(t.parent_task))) walk(t, 0)
    for (const t of shown) walk(t, 0)
  }
  const counts = {}
  for (const t of everything) counts[t.status] = (counts[t.status] || 0) + 1
  const chip = (href, text, on, tone = '') => el('a', { class: `pill ${tone}${on ? ' on' : ''}`, href, 'aria-current': on ? 'true' : undefined, text })
  const toggle = el('div', { class: 'chips filters', role: 'navigation', 'aria-label': 'Фильтр задач по статусу' },
    chip('#/tasks', `открытые ${everything.filter(isOpen).length}`, !all && !status),
    chip('#/tasks?all=1', `все ${everything.length}`, all && !status),
    ...Object.entries(counts).map(([k, v]) => chip(`#/tasks?status=${encodeURIComponent(k)}`, `${statusText(k)} ${v}`, status === k, STATUS_TONE[k] || '')))
  // A long list is searched, not scrolled: id, title, owner and the status word
  // (raw or Russian) are all matched.
  // "Not started" and "in work" only repeat the status and the owner beside them; the line under the title is kept
  // for reasons the row does not already show (blocked, changes requested, ready to close, ...).
  const QUIET = new Set(['not_started', 'in_work'])
  // The owner closes open tasks in batches from here (a ticked row, one reason for all). Only a panel that may write
  // shows the boxes; a closed task has none — it is reopened from its own page.
  const canWrite = await panelWritable()
  const selected = new Set()
  // Always there while the panel may write, its buttons greyed until a row is ticked: a bar that appeared on the first
  // tick pushed the table down, and the next click landed on the row above the one aimed at.
  const bar = el('div', { class: 'toolbar', hidden: !canWrite })
  const formBox = el('div', {})
  const rows = list.map((t) => {
    const box = canWrite && isOpen(t) ? el('input', { type: 'checkbox', 'aria-label': `Выбрать: ${t.title}`, onchange: (e) => {
      if (e.target.checked) selected.add(t.id); else selected.delete(t.id)
      drawBar()
    } }) : null
    return {
      id: t.id,
      box,
      text: `${t.id} ${t.title} ${t.owner || ''} ${t.working_model?.model || ''} ${t.status} ${statusText(t.status)} ${t.standstill ? `${STANDSTILL_RU[t.standstill.code] || ''} ${t.standstill.detail}` : ''}`.toLowerCase(),
      node: linkRow(`#/tasks/${encodeURIComponent(t.id)}`, [
        // The whole cell is the box's label: a click a little beside the box ticks it rather than opening the task.
        canWrite ? td(box ? el('label', { class: 'checkcell' }, box) : null, 'nw check') : null,
        td([pill(t.status), t.closed_by_owner ? [' ', el('span', { class: 'pill warn', title: ownerClosedNote(t.closed_by_owner), text: 'владельцем' })] : null], 'nw'),
        td([depthOf.get(t.id) ? el('span', { class: 'muted', style: `margin-left:${(depthOf.get(t.id) - 1) * 18}px`, text: '↳ ' }) : null,
          el('a', { href: `#/tasks/${encodeURIComponent(t.id)}`, text: t.title }),
          t.parent_task && !depthOf.get(t.id) ? el('div', { class: 'muted small' }, 'в рамках ', el('a', { href: `#/tasks/${encodeURIComponent(t.parent_task)}`, class: 'mono', text: t.parent_task })) : null,
          t.standstill && !QUIET.has(t.standstill.code)
            ? el('div', { class: 'muted small' }, STANDSTILL_RU[t.standstill.code] === statusText(t.status) ? null : [standstillPill(t.standstill), ' '], t.standstill.detail)
            : null]),
        td(t.owner ? [el('span', { class: 'mono', text: t.owner }), t.working_model ? el('div', { class: 'muted small', title: t.working_model.model_known ? '' : 'Модель не из реестра', text: t.working_model.model_ref || t.working_model.model }) : null] : el('span', { class: 'muted', text: '—' }), 'nw')])
    }
  })
  function closeSelected(outcome) {
    const ids = [...selected]
    formBox.replaceChildren(ownerForm({
      title: `${outcome === 'completed' ? 'Завершить' : 'Отменить'} выбранные задачи: ${ids.length}`,
      lines: OWNER_CLOSE_LINES,
      warning: outcome === 'completed' ? 'Задачи будут помечены завершёнными без проверок: обязательное ревью, если оно не пройдено, пропускается. Если работа не сделана — выберите «Отменить».' : null,
      confirmText: `Да, ${outcome === 'completed' ? 'завершить' : 'отменить'} ${ids.length}`,
      onCancel: () => formBox.replaceChildren(),
      onConfirm: async (reason) => {
        const done = await post('/api/tasks/close', { task_ids: ids, outcome, reason })
        toast(`${OWNER_OUTCOME_RU[outcome]}: ${done.closed.length}`)
        await route()
      }
    }))
  }
  function drawBar() {
    const none = selected.size === 0
    if (none) formBox.replaceChildren()
    bar.replaceChildren(el('span', { class: none ? 'muted' : '', text: none ? 'Отметьте задачи, чтобы отменить или завершить их разом' : `Выбрано: ${selected.size}` }),
      el('button', { type: 'button', disabled: none, text: 'Отменить выбранные', onclick: () => closeSelected('cancelled') }),
      el('button', { type: 'button', disabled: none, text: 'Завершить выбранные', onclick: () => closeSelected('completed') }),
      el('button', { type: 'button', disabled: none, text: 'Снять выбор', onclick: () => {
        selected.clear()
        for (const row of rows) if (row.box) row.box.checked = false
        if (selectAll) selectAll.checked = false
        formBox.replaceChildren()
        drawBar()
      } }))
  }
  // "Select all" picks the rows the search leaves visible, never hidden ones.
  const selectAll = canWrite && rows.some((row) => row.box) ? el('input', { type: 'checkbox', 'aria-label': 'Выбрать все видимые', onchange: (e) => {
    for (const row of rows) {
      if (!row.box || row.node.hidden) continue
      row.box.checked = e.target.checked
      if (e.target.checked) selected.add(row.id); else selected.delete(row.id)
    }
    drawBar()
  } }) : null
  if (canWrite && rows.some((row) => row.box)) drawBar()
  else bar.hidden = true
  const none = el('div', { class: 'empty', text: 'Ничего не найдено', hidden: true })
  const noun = status ? `«${statusText(status)}»` : all ? 'всего' : 'открытых'
  const count = el('span', { class: 'muted small', text: `${list.length} ${noun}` })
  const search = el('input', { type: 'search', placeholder: 'Поиск', title: 'Номер, название, исполнитель или статус', 'aria-label': 'Поиск по задачам: номер, название, исполнитель, статус', oninput: (e) => {
    const query = e.target.value.trim().toLowerCase()
    let shown = 0
    for (const row of rows) {
      row.node.hidden = Boolean(query) && !row.text.includes(query)
      if (!row.node.hidden) shown += 1
    }
    none.hidden = shown > 0
    count.textContent = query ? `${shown} из ${list.length}` : `${list.length} ${noun}`
  } })
  const table = list.length ? dataTable([...(canWrite ? [''] : []), 'Статус', 'Задача', 'Исполнитель'], rows.map((row) => row.node)) : empty('Задач нет')
  if (selectAll && table.tagName === 'TABLE') table.querySelector('th').append(selectAll)
  return page('Задачи', status ? `Задачи со статусом «${statusText(status)}»` : all ? 'Все задачи' : 'Открытые задачи', toggle, el('div', { class: 'toolbar' }, search, count),
    bar, formBox, table, none)
}

const TERMINAL = new Set(['completed', 'cancelled'])

async function taskDetail(id) {
  const data = await api(`/api/tasks/${encodeURIComponent(id)}`)
  const t = data.task
  const section = (title, heads, items, render) => [el('h2', { text: title }), items?.length ? dataTable(heads, items.map(render)) : empty('—')]
  // The owner's buttons (collab/src/domain/owner.mjs), only on a panel that may write: an open task can be completed
  // or cancelled around its gates; a closed one can be put back in the pool.
  const canWrite = await panelWritable()
  const formBox = el('div', {})
  const closed = TERMINAL.has(t.status)
  const reviewPassed = (data.reviews || []).some((r) => r.verdict === 'approved')
  const closeForm = (outcome) => formBox.replaceChildren(ownerForm({
    title: outcome === 'completed' ? 'Завершить задачу' : 'Отменить задачу',
    lines: OWNER_CLOSE_LINES,
    warning: outcome === 'completed' && t.needs_review !== false && !reviewPassed
      ? 'Ревью не пройдено — задача будет помечена завершённой без проверки. Если работа не сделана, выберите «Отменить».'
      : null,
    confirmText: outcome === 'completed' ? 'Да, завершить' : 'Да, отменить',
    onCancel: () => formBox.replaceChildren(),
    onConfirm: async (reason) => {
      await post('/api/tasks/close', { task_ids: [t.id], outcome, reason })
      toast(`Задача ${OWNER_OUTCOME_RU[outcome]}`)
      await route()
    }
  }))
  const reopenForm = () => formBox.replaceChildren(ownerForm({
    title: 'Вернуть в открытые',
    lines: [`Задача станет «создана», без исполнителя: её возьмёт ${t.role ? `агент с ролью ${t.role}` : 'любой агент'}. Прежний итог и ревью останутся в истории.`,
      ...(t.needs_review !== false ? ['Чтобы завершить её снова, понадобится пройденное ревью.'] : [])],
    confirmText: 'Да, вернуть',
    onCancel: () => formBox.replaceChildren(),
    onConfirm: async (reason) => {
      await post('/api/tasks/reopen', { task_id: t.id, reason })
      toast('Задача снова открыта')
      await route()
    }
  }))
  const ownerButtons = !canWrite ? [] : closed
    ? [el('button', { type: 'button', text: 'Вернуть в открытые', onclick: reopenForm })]
    : [el('button', { type: 'button', text: 'Завершить', onclick: () => closeForm('completed') }),
       el('button', { type: 'button', text: 'Отменить', onclick: () => closeForm('cancelled') })]
  const lastReopen = [...(t.owner_history || [])].reverse().find((h) => h.action === 'reopened')
  // The planned route (spec.route, the plan's "Маршрут:" line as data) beside what is on record as having happened:
  // the model the owner works on, the subagents handed work, the reviews with their models. A plan without facts, or
  // facts without a plan, is shown as it is — an empty side says so instead of hiding the block.
  const modelText = (m) => (m ? `${m.model_ref || m.model}${m.effort ? ` · ${m.effort}` : ''}${m.model_known ? '' : ' (не из реестра)'}` : '')
  const planned = t.spec?.route || []
  const actual = [
    // Named by who recorded it: the owner may have changed since, and a model must not be put on the wrong agent.
    t.working_model ? `${t.working_model.by || '?'} — работает на ${modelText(t.working_model)}` : null,
    ...(data.delegations || t.delegations || []).map((d) => `${d.to || '?'} — ${d.model || '?'}${d.level ? ` · ${d.level}` : ''}${d.purpose ? `: ${d.purpose}` : ''}${d.finished_at || d.outcome ? '' : ' (без итога)'}`),
    ...(data.reviews || []).map((r) => `ревью ${r.reviewer || r.reviewer_agent || '?'}${r.reviewer_model ? ` на ${r.reviewer_model}` : ''} — ${r.verdict || 'ждёт'}`)
  ].filter(Boolean)
  return page(t.title, `${t.id} · ${t.owner || 'без исполнителя'}${t.working_model ? ` · ${t.working_model.model_ref || t.working_model.model}` : ''} · ${t.role || 'роль не указана'}`,
    // Back goes to the list the task can be found in: a closed task is not in the open-only list.
    el('div', { class: 'toolbar' }, pill(t.status), el('a', { href: closed ? '#/tasks?all=1' : '#/tasks', text: '← к списку задач' }),
      ownerButtons.length ? el('span', { class: 'grow' }) : null, ...ownerButtons),
    formBox,
    data.skills?.length ? el('div', { class: 'muted small' }, `Скиллы роли ${t.role} (подсказка исполнителю): `, data.skills.map((name, i) => [i ? ', ' : '', el('span', { class: 'mono', text: name })])) : null,
    data.parent ? el('div', { class: 'note' }, 'Создана в рамках задачи ', el('a', { href: `#/tasks/${encodeURIComponent(data.parent.id)}`, text: data.parent.title }), ' ', pill(data.parent.status))
      : t.parent_task ? el('div', { class: 'note', text: `Создана в рамках задачи ${t.parent_task}` }) : null,
    t.closed_by_owner ? el('div', { class: 'note warn', text: `Закрыта мимо проверок: ${ownerClosedNote(t.closed_by_owner)}` }) : null,
    lastReopen && !closed ? el('div', { class: 'note', text: `Возвращена владельцем ${when(lastReopen.at)} (была «${statusText(lastReopen.from_status)}»): ${lastReopen.reason}` }) : null,
    data.standstill
      ? el('div', { class: `note ${STANDSTILL_TONE[data.standstill.code] === 'bad' ? 'bad' : 'warn'}` },
          el('strong', { text: `Почему не завершена: ${STANDSTILL_RU[data.standstill.code] || data.standstill.code}` }), el('br'),
          data.standstill.detail,
          ...(data.standstill.obstacles || []).filter((o) => o !== data.standstill.detail).flatMap((o) => [el('br'), `Мешает закрытию: ${o}`]))
      : null,
    t.blocked_reason ? el('div', { class: 'note bad', text: `Заблокирована: ${plain(t.blocked_reason)}` }) : null,
    // What the task waits on, in words; a review it waits on is already named in "Почему не завершена" above.
    (() => {
      const w = t.waiting_on
      if (!w || TERMINAL.has(t.status)) return null
      const text = typeof w === 'string' ? w : w.kind === 'user' ? `вашего ответа на одобрение ${w.ref || ''}` : w.kind === 'agent' && data.standstill ? null : plain(w)
      return text ? el('div', { class: 'note warn', text: `Ждёт: ${text}` }) : null
    })(),
    t.completion_summary ? [el('h2', { text: 'Итог' }), el('div', { class: 'card' }, prose(t.completion_summary))] : null,
    t.description ? el('div', { class: 'card' }, prose(t.description)) : null,
    t.spec?.acceptance_criteria?.length ? [el('h2', { text: 'Критерии приёмки' }), el('div', { class: 'card' }, t.spec.acceptance_criteria.map((c) => el('div', { text: `• ${c}` })))] : null,
    data.children?.length ? [el('h2', { text: 'Созданные в рамках этой задачи' }), dataTable(['Статус', 'Задача', 'Исполнитель'], data.children.map((c) => linkRow(`#/tasks/${encodeURIComponent(c.id)}`, [
      td(pill(c.status), 'nw'), td(el('a', { href: `#/tasks/${encodeURIComponent(c.id)}`, text: c.title })),
      td(c.owner ? el('span', { class: 'mono', text: c.owner }) : el('span', { class: 'muted', text: '—' }), 'nw')])))] : null,
    planned.length || actual.length ? [el('h2', { text: 'Маршрут: план и факт' }), dataTable(['План', 'Факт'], [el('tr', {},
      td(planned.length ? planned.map((r) => el('div', { text: `${r.step}${r.agent ? ` — ${r.agent}` : ''}${r.model ? ` · ${r.model}` : ''}${r.level ? ` · ${r.level}` : ''}` })) : el('span', { class: 'muted', text: 'план не записан' })),
      td(actual.length ? actual.map((line) => el('div', { text: line })) : el('span', { class: 'muted', text: 'пока ничего' })))])] : null,
    costBlock(data),
    // The verdict alone is not the review: what the reviewer found is the point.
    [el('h2', { text: 'Ревью' }), data.reviews?.length ? data.reviews.map(reviewCard) : empty('—')],
    // The outcome is the lead's free-text report, often a paragraph: it goes under the purpose and wraps. As a
    // no-wrap pill it pushed the row off the page and squeezed the purpose to one letter per line.
    section('Поручения субагентам', ['Кому', 'Модель', 'Поручение и итог', 'Состояние'], data.delegations || t.delegations, (d) => el('tr', {},
      td(el('span', { class: 'mono', text: d.to || '' }), 'nw'), td(el('span', { class: 'pill', text: `${d.model || ''}${d.level ? ` · ${d.level}` : ''}` }), 'nw'),
      td([el('div', { text: d.purpose || '' }), d.outcome ? el('div', { class: 'muted', text: d.outcome }) : null]),
      td(d.finished_at || d.outcome ? el('span', { class: 'pill ok', text: 'закрыто' }) : el('span', { class: 'pill warn', text: 'без итога' }), 'nw'))),
    section('Прогоны проверок', ['Результат', 'Проверка', 'Итог'], t.runs, (r) => el('tr', {},
      td(runPill(r.status), 'nw'), td(el('span', { class: 'mono', text: r.runner }), 'nw'), td(r.headline || ''))),
    section('Сообщения', ['От', 'Когда', 'Сообщение'], data.messages, (m) => el('tr', {},
      td(el('span', { class: 'mono', text: m.from_agent || '?' }), 'nw'), td(el('span', { class: 'muted small', text: when(m.created_at) }), 'nw'),
      td([m.subject ? el('strong', { text: m.subject }) : null, m.body ? prose(m.body) : null]))),
    t.files?.length ? [el('h2', { text: 'Файлы задачи' }), el('div', { class: 'card mono', text: t.files.join('\n') })] : null)
}

// What the task cost, from the agents' own session logs (collab/src/usage.mjs): tokens per agent and model, for Codex
// also how far the weekly limit moved. Read on demand and never stored, so every figure says what it is a reading of.
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n))
const freshOf = (row) => (row.input || 0) + (row.output || 0) + (row.cache_creation || 0)
function costBlock(data) {
  const usage = data.usage
  const branch = data.branch
  const rows = (usage?.parts || []).flatMap((part) => Object.entries(part.by_model || {}).map(([model, row]) => ({ part, model, row })))
  const hasOwn = rows.length > 0
  const hasBranch = branch && branch.descendants > 0 && !branch.none
  if (!hasOwn && !hasBranch) {
    return [el('h2', { text: 'Расход' }), el('div', { class: 'empty', text: 'Данных нет: у задачи нет записанной сессии, а журнал Codex с её взятием на этой машине не найден.' })]
  }
  const table = hasOwn ? dataTable(['Агент', 'Модель', 'Токены', 'Из кэша', 'Недельный лимит'], rows.map(({ part, model, row }) => el('tr', {},
    td(el('span', { class: 'mono', text: part.agent }), 'nw'), td(el('span', { class: 'pill', text: model }), 'nw'),
    td(`${tokens(freshOf(row))}`, 'nw'), td(row.cache_read ? tokens(row.cache_read) : '—', 'nw'),
    td(part.limit_percent === null || part.limit_percent === undefined ? el('span', { class: 'muted', text: part.agent === 'codex' ? 'не определён' : '—' }) : `≈ ${part.limit_percent}%`, 'nw')))) : null
  const notes = [
    usage?.approximate ? 'Цифры приблизительные (≈): сессия вела и другие задачи в то же время, поэтому здесь верхняя граница, а не точная стоимость задачи.' : null,
    rows.some(({ part }) => part.limit_percent !== null && part.limit_percent !== undefined) ? 'Процент у Codex — недельный лимит всего аккаунта, целыми процентами: он показывает, насколько лимит сдвинулся за время задачи, включая всё остальное, что Codex делал параллельно.' : null,
    rows.some(({ part }) => part.agent === 'claude') ? 'У Claude процента лимита в логах нет — только токены.' : null
  ].filter(Boolean)
  return [el('h2', { text: 'Расход' }), table,
    hasBranch ? el('div', { class: 'note' }, `По ветке, с ${branch.descendants} созданными в рамках этой задачи: ${tokens(freshOf(branch.total))} токенов${branch.total.cache_read ? `, из кэша ещё ${tokens(branch.total.cache_read)}` : ''}${branch.approximate ? ' (≈)' : ''}.`) : null,
    notes.map((text) => el('div', { class: 'muted small', text }))]
}

const labelled = (label, text, purpose) => el('div', {}, el('div', { class: 'cmd-label', text: label }), command(text, purpose))
const plain = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))

// Agents write task descriptions, summaries and messages in light Markdown: numbered and "-" lists, `code`,
// **bold**, "Label: text", a long comma list of paths. Shown as one paragraph it was a wall of text. Everything is
// built as DOM nodes and text nodes, never parsed as markup: the text comes from agents, and no HTML in it may run.
function inlineText(text) {
  const out = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(m[1] !== undefined ? el('code', { text: m[1] }) : el('strong', { text: m[2] }))
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// "a/b.js, c/{d,e}.js; f" → items, not splitting inside {…} alternatives.
function splitItems(text) {
  const items = []
  let depth = 0
  let current = ''
  for (const c of text) {
    if (c === '{') depth++
    if (c === '}') depth = Math.max(0, depth - 1)
    if ((c === ',' || c === ';') && depth === 0) {
      if (current.trim()) items.push(current.trim())
      current = ''
    } else current += c
  }
  if (current.trim()) items.push(current.trim().replace(/\.$/, ''))
  return items
}

// "Label: text" → bold label; when the text is mostly paths, one path per line.
function withLabel(text) {
  const m = /^([^:\n]{2,90}):\s+(\S.*)$/.exec(text)
  // "Run the classes (backend: …)" — a colon inside an open bracket is not the end of a label.
  if (!m || (m[1].match(/\(/g) || []).length !== (m[1].match(/\)/g) || []).length) return inlineText(text)
  const items = splitItems(m[2])
  // A path is a short item led by a word with a slash ("a/b.js", "a/b.prisma + миграция") — not a sentence that
  // happens to mention "x/y".
  const isPath = (item) => /^\S*\/\S*/.test(item) && item.split(/\s+/).length <= 3
  if (items.length >= 3 && items.filter(isPath).length * 2 >= items.length) {
    return [el('strong', {}, inlineText(`${m[1]}:`)), el('ul', { class: 'paths' }, items.map((item) => el('li', {}, el('code', { text: item }))))]
  }
  return [el('strong', {}, inlineText(`${m[1]}:`)), ' ', ...inlineText(m[2])]
}

function prose(value) {
  const box = el('div', { class: 'prose' })
  let list = null
  for (const raw of plain(value).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      list = null
      continue
    }
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line)
    const bullet = ordered ? null : /^[-•]\s+(.*)$/.exec(line)
    if (ordered || bullet) {
      const tag = ordered ? 'OL' : 'UL'
      if (!list || list.tagName !== tag) {
        list = el(tag.toLowerCase(), ordered && ordered[1] !== '1' ? { start: ordered[1] } : {})
        box.append(list)
      }
      list.append(el('li', {}, withLabel(ordered ? ordered[2] : bullet[1])))
      continue
    }
    list = null
    // A short line ending with a colon introduces what follows: a heading, not a sentence.
    box.append(line.endsWith(':') && line.length <= 140 ? el('p', { class: 'lead' }, el('strong', {}, inlineText(line))) : el('p', {}, withLabel(line)))
  }
  return box
}

function reviewCard(r) {
  const findings = r.findings || []
  return el('div', { class: 'card' },
    el('div', {}, pill(r.verdict || 'pending'), ' ', el('span', { text: `${slotText(r)}${r.round ? ` · раунд ${r.round}` : ''}` }),
      r.reviewer ? el('span', { class: 'muted', text: ` · проверяет ${r.reviewer}` }) : r.requested_role ? el('span', { class: 'muted', text: ` · ждёт ${r.requested_role}` }) : null,
      r.independence === 'same_agent_separate_session' ? el('span', { class: 'pill warn', text: 'тот же агент' }) : null,
      r.independence === 'same_vendor' ? el('span', { class: 'pill warn', text: 'тот же вендор' }) : null,
      r.reviewer_model ? el('span', { class: 'pill', text: `ревьюер: ${r.reviewer_model}${r.reviewer_model_level ? ` (${r.reviewer_model_level})` : ''}${r.author_model ? `, автор: ${r.author_model}` : ''}` }) : null),
    r.summary ? el('div', { class: 'detail' }, prose(r.summary)) : null,
    ...findings.map((f) => el('div', { class: 'position' },
      el('span', { class: `pill ${f.severity === 'blocker' || f.severity === 'major' ? 'bad' : ''}`, text: f.severity || 'нет оценки' }),
      f.file ? el('span', { class: 'mono small', text: ` ${f.file}${f.line ? `:${f.line}` : ''}` }) : null,
      el('div', { class: 'muted', text: plain(f.note || f.summary || f.title || '') }))))
}

// The chosen agents the lead cannot start: not the lead, and no command another agent could start them with on this
// machine (`launchable` from /api/setup/detect). A server too old to send `launchable` answers nothing — no warning
// is better than a false one.
function unledWithoutCli(chosen, lead, launchable) {
  if (!Array.isArray(launchable)) return []
  return [...chosen].filter((id) => id !== lead && !launchable.includes(id))
}

// Ids in a copyable command come from the journal, and agents write the journal: an option id `ok; rm -rf ~`
// would run when the owner pastes the line. A plain id stays as is, anything else is single-quoted; an id with a
// control character (a newline would end the command) gets no command at all.
function shellArg(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9._:@%+=,/-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function commandLine(parts) {
  return parts.some((p) => /[\u0000-\u001f\u007f]/.test(String(p ?? ''))) ? null : parts.join(' ')
}

function labelledCommand(title, parts, what) {
  const line = commandLine(parts)
  return line === null
    ? el('div', { class: 'note bad', text: `${title}: идентификатор содержит управляющие символы — команду не предлагаем, проверьте запись в журнале.` })
    : labelled(title, line, what)
}

// Why an action needs the owner, in the owner's words. The policy class is the journal's; the line under it says what
// it guards. SECURITY_SENSITIVE is also where an action the table did not recognise falls — said apart, because then
// nothing dangerous was found: the description simply had no verb the table knows.
const ACTION_CLASS_RU = {
  FINANCIAL: ['Деньги', 'Может стоить денег — сейчас или в следующем счёте.'],
  PRODUCTION: ['Прод', 'Меняет то, что получают настоящие пользователи: деплой, релиз, TestFlight.'],
  SECURITY_SENSITIVE: ['Безопасность', 'Касается доступов, токенов, ключей или прав.'],
  DESTRUCTIVE: ['Удаление', 'Стирает работу или данные, которые git не вернёт.'],
  EXTERNAL_SIDE_EFFECT: ['Наружу', 'Уходит за пределы машины и видно другим: push, PR, письмо, публикация.'],
  SAFE_WRITE: ['Правка', 'Обычная правка в дереве.'],
  READ_ONLY: ['Чтение', 'Ничего не меняет.']
}
const UNMATCHED = /^nothing in the policy table matched/
function whyOwner(actionClass, policyReason) {
  const [name, line] = ACTION_CLASS_RU[actionClass] || [actionClass || 'класс не указан', '']
  const guessed = UNMATCHED.test(policyReason || '')
  return el('div', {},
    el('span', { class: 'pill warn', title: actionClass || '', text: guessed ? `${name} — на всякий случай` : name }), ' ',
    el('span', { class: 'muted small', text: guessed
      ? 'Журнал не узнал действие: в описании нет глагола из таблицы («исправить», «добавить», «написать тест»…). Опасного в нём не найдено — спрашивает на всякий случай.'
      : line }),
    policyReason && !guessed ? el('div', { class: 'muted small', text: `Правило: ${policyReason}` }) : null)
}

// The same action read by the policy table in force now. When it disagrees with the class the task waits under, the
// owner learns the wait comes from an older reading — and, when the table now asks nothing, that it is safe to close
// the task or let the agent ask again.
function nowReading(storedClass, now) {
  const [name] = ACTION_CLASS_RU[now.action_class] || [now.action_class]
  const why = now.recognised ? `Правило: ${now.reason}` : 'Действие не узнано — на всякий случай.'
  // Same class: unrecognised is already said by the pill above; a recognised rule is named once, here.
  if (now.action_class === storedClass) return now.recognised ? el('div', { class: 'muted small', text: why }) : null
  return el('div', { class: now.requires_approval ? 'note warn' : 'note ok' },
    el('strong', { text: `По нынешней таблице это «${name}»` }),
    now.requires_approval ? ` — одобрение по-прежнему нужно. ${why}` : ` — одобрение не нужно. Задача ждёт по прежнему прочтению журнала: её можно закрыть или попросить агента завести заново. ${why}`)
}

// A task waiting for the owner, and what the owner can do about it NOW — the command for its state.
function waitingTaskCard(t) {
  const close = labelledCommand('Или закрыть задачу (в терминале, причина обязательна)', ['collab', 'close', shellArg(t.id), '--cancel', '--reason', '"причина"'], `команду закрытия задачи ${t.id}`)
  return el('div', { class: 'card' },
    el('div', {}, el('a', { href: `#/tasks/${encodeURIComponent(t.id)}` }, el('strong', { text: t.title || t.id })), el('span', { class: 'mono muted', text: `  ${t.id}` })),
    t.action ? el('div', { class: 'small' }, el('span', { class: 'muted', text: 'Действие: ' }), t.action) : null,
    el('h3', { text: 'Почему нужно ваше слово' }),
    // The stored class is what blocks the task; the reason recorded with its approval may come from another rule of
    // an older table, so when the table in force can be read, its own reading is shown instead of that reason.
    whyOwner(t.action_class, t.now ? (t.now.recognised || t.now.action_class !== t.action_class ? null : 'nothing in the policy table matched') : t.policy_reason),
    t.now ? nowReading(t.action_class, t.now) : null,
    t.reason ? el('p', { class: 'small' }, el('span', { class: 'muted', text: `Агент (${t.owner || '?'}) пишет: ` }), t.reason) : null,
    ...(t.state === 'live'
      ? [el('div', { class: 'note ok', text: `Одобрение можно выдать${t.approval?.expires_at ? ` — до ${when(t.approval.expires_at)}` : ''}.` }),
         labelledCommand('Одобрить (в терминале)', ['collab', 'approve', shellArg(t.approval.id)], `команду одобрения задачи ${t.id}`),
         labelledCommand('Отклонить (в терминале, причина обязательна)', ['collab', 'reject', shellArg(t.approval.id), '--note', '"причина"'], `команду отклонения задачи ${t.id}`)]
      : t.state === 'expired'
        ? [el('div', { class: 'note bad', text: `Запрос на одобрение просрочен${t.approval?.expires_at ? ` (${when(t.approval.expires_at)})` : ''}: выдать его уже нельзя. Попросите агента ${t.owner || ''} запросить одобрение заново — или закройте задачу, если она не нужна.` }), close]
        : [el('div', { class: 'note warn', text: `Запроса на одобрение нет. Попросите агента ${t.owner || ''} запросить его — или закройте задачу, если она не нужна.` }), close]))
}

// What the owner needs to judge a request: the action, what it costs, why it is
// asked, until when it holds, and both ways to answer it.
function approvalCard(x) {
  return el('div', { class: 'card' },
    el('div', {}, el('strong', { text: x.action?.summary || (typeof x.action === 'string' ? x.action : null) || x.id })),
    x.task_id ? el('div', { class: 'small' }, el('span', { class: 'muted', text: 'к задаче ' }), el('a', { href: `#/tasks/${encodeURIComponent(x.task_id)}`, text: x.task_title || x.task_id })) : null,
    whyOwner(x.action_class, x.policy_reason),
    x.reason ? el('p', { text: x.reason }) : null,
    x.details ? el('div', { class: 'detail', text: plain(x.details) }) : null,
    x.cost_estimate ? el('div', { class: 'note warn', text: `Оценка стоимости: ${plain(x.cost_estimate)}` }) : null,
    x.expired
      ? el('div', { class: 'note bad', text: `Срок действия истёк ${when(x.expires_at)}: одобрение, скорее всего, уже не примут; агент должен запросить его заново.` })
      : x.expires_at ? el('div', { class: 'muted small', text: `Действует до ${when(x.expires_at)}` }) : null,
    el('div', { class: 'mono muted' }, `запросил ${x.requested_by || '?'}`, x.task_id ? [' · ', el('a', { href: `#/tasks/${encodeURIComponent(x.task_id)}`, text: `задача ${x.task_id}` })] : null),
    // An expired request cannot be granted; offering its commands only sends the
    // owner to a terminal failure, so it gets none.
    ...(x.expired
      ? []
      : [labelledCommand('Одобрить (в терминале)', ['collab', 'approve', shellArg(x.id)], 'команду одобрения'),
         labelledCommand('Отклонить (в терминале, причина обязательна)', ['collab', 'reject', shellArg(x.id), '--note', '"причина"'], 'команду отклонения')]))
}

// A dispute is decided by reading the question, the options and what each agent
// argued for, then answering with one option's id.
function decisionCard(x) {
  const options = x.options || []
  const label = new Map(options.map((o) => [o.id, o.label || o.id]))
  return el('div', { class: 'card' },
    el('div', {}, el('strong', { text: x.title || x.id }), ' ', pill(x.status)),
    // The task this question belongs to, as the delegations block shows it: status first, then the title as a link.
    x.task_id
      ? el('div', { class: 'row' }, el('span', { class: 'muted small', text: 'к задаче' }), x.task_status ? pill(x.task_status) : null,
          el('a', { class: 'grow', href: `#/tasks/${encodeURIComponent(x.task_id)}`, text: x.task_title || x.task_id }))
      : null,
    x.context ? el('div', { class: 'detail', text: plain(x.context) }) : null,
    options.length ? el('h3', { text: 'Варианты' }) : null,
    ...options.map((o) => el('div', { class: 'option' },
      el('div', {}, el('strong', { text: o.label || o.id })),
      o.summary ? el('div', { class: 'muted', text: o.summary }) : null,
      labelledCommand('Выбрать (в терминале)', ['collab', 'decide', shellArg(x.id), shellArg(o.id)], `команду выбора варианта «${o.label || o.id}»`))),
    // A dispute without predefined options is answered in the owner's own words.
    ...(options.length ? [] : [labelledCommand('Ответить своими словами (в терминале)', ['collab', 'decide', shellArg(x.id), '<ваше решение>'], 'команду ответа на спор')]),
    (x.positions || []).length ? el('h3', { text: 'Позиции агентов' }) : null,
    ...(x.positions || []).map((p) => el('div', { class: 'position' },
      el('span', { class: 'mono', text: `${p.agent || '?'} → ${label.get(p.option) || p.option || '—'}` }),
      p.rationale ? el('div', { class: 'muted', text: p.rationale }) : null)))
}

async function waiting() {
  const data = await api('/api/waiting')
  const live = (data.approvals || []).filter((x) => !x.expired)
  const stale = (data.approvals || []).filter((x) => x.expired)
  const d = data.decisions || []
  const r = data.reviews || []
  const t = data.tasks || []
  return page('Ждёт вас', 'Одобрения и выбор по вопросам даются только в терминале: панель их показывает, но не выдаёт. Команду скопируйте и выполните в своём терминале.',
    el('h2', { text: `Задачи ждут вас (${t.length})` }),
    t.length
      ? [el('p', { class: 'sub', text: 'Задача стоит, пока вы не ответите: взять её в работу или закрыть агент не может. Под каждой — почему она ждёт и что сделать сейчас.' }), ...t.map(waitingTaskCard)]
      : empty('Ни одна задача не ждёт вас'),
    el('h2', { text: `Одобрения (${live.length})` }),
    live.length ? live.map(approvalCard) : empty('Нет одобрений, которые можно выдать'),
    // Expired requests are not work for the owner: they are kept apart and folded,
    // so a long tail of them does not bury the live ones.
    stale.length
      ? el('details', { class: 'stale' }, el('summary', { text: `Просроченные одобрения (${stale.length}): выдать их уже нельзя, агент должен запросить заново` }), ...stale.map(approvalCard))
      : null,
    el('h2', { text: `Вопросы ждут вашего выбора (${d.length})` }),
    d.length
      ? [el('p', { class: 'sub', text: 'Вопрос — не задача: агент спрашивает, какой вариант выбрать, и выбрать можете только вы. Он закрывается вашей командой collab decide; выбор, сказанный в разговоре, вопрос не закрывает.' }), ...d.map(decisionCard)]
      : empty('Вопросов нет'),
    el('h2', { text: `Ревью в очереди (${r.length})` }),
    r.length
      ? dataTable(['Статус', 'Ревью', 'Ждёт', 'Задача'], r.map((x) => linkRow(`#/tasks/${encodeURIComponent(x.task_id)}`, [
          td(pill('pending'), 'nw'), td(slotText(x), 'nw'),
          td(el('span', { class: 'mono', text: x.reviewer || x.requested_role || x.reviewer_role || '—' }), 'nw'),
          td(el('a', { href: `#/tasks/${encodeURIComponent(x.task_id)}`, text: x.task_title || x.task_id }))])))
      : empty('Очередь пуста'))
}


async function roster() {
  const data = await api('/api/roster')
  return page('Состав', `Ведущий: ${data.lead || 'не назначен'} · ${REVIEW_MODE_RU[data.review_mode] || data.review_mode || 'режим ревью не задан'}`,
    data.lead ? null : el('div', { class: 'note warn' }, 'Состав на этой машине не настроен, действуют встроенные настройки. ', el('a', { href: '#/setup', text: 'Открыть мастер настройки' })),
    el('h2', { text: 'Агенты' }),
    el('table', {}, el('thead', {}, el('tr', {}, ['Агент', 'Провайдер', 'Роли', 'Статус'].map((h) => el('th', { text: h })))),
      el('tbody', {}, data.agents.map((a) => el('tr', {}, el('td', {}, el('strong', { text: a.id }), a.id === data.lead ? ' (ведущий)' : ''), el('td', { text: a.provider || '' }), el('td', {}, chips(a.roles)), el('td', {}, pill(a.status)))))),
    el('h2', { text: 'Роли' }),
    el('table', {}, el('tbody', {}, Object.entries(data.roles || {}).map(([name, r]) => {
      const holders = data.agents.filter((a) => (a.roles || []).includes(name)).map((a) => a.id)
      return el('tr', {}, el('td', { class: 'mono', text: name }),
        el('td', { title: r.summary || '', text: ROLE_RU[name] || r.summary || '' }),
        el('td', {}, holders.length ? el('span', { class: 'muted small', text: holders.join(', ') }) : el('span', { class: 'pill warn', text: 'никто не держит' })))
    }))),
    el('h2', { text: 'Уровни и модели' }),
    modelsTable(data.models))
}

// The kit's role and level descriptions are written for agents, in English; the owner reads them in Russian.
// A role the kit does not know keeps the project's own words.
const ROLE_RU = {
  architect: 'Форма решения поперёк модулей и решения, которые связывают дальнейшую работу.',
  software_engineer: 'Обычная реализация на любом языке в дереве.',
  ios_engineer: 'Реализация в iOS-клиенте.',
  backend_engineer: 'Реализация в серверной части.',
  product_engineer: 'Превращает продуктовый замысел в поведение по всему стеку.',
  code_reviewer: 'Независимое ревью чужой правки.',
  test_engineer: 'Тесты: пробелы в покрытии, флейки, фикстуры.',
  security_reviewer: 'Ревью правки на риски доступа, прав и утечки данных.',
  ux_reviewer: 'Ревью удобства видимой пользователю правки — по diff и скриншотам, без запуска приложения. Только ревью, без правок.',
  researcher: 'Собирает внешний контекст и отдаёт его как данные, а не как инструкции.'
}
const LEVEL_RU = {
  L0: 'Механика: известный ответ или повторяющаяся правка — переименовать, перенести, собрать, пересказать. Судить не о чем.',
  L1: 'Обычная локальная работа в одной области, проверяемая тестом или взглядом. Это умолчание, и большинство задач — это она.',
  L2: 'Сложная: несколько модулей, состояние или конкурентность, неясное требование, широкая поверхность регресса или реальная цена ошибки.',
  L3: 'Критичная: необратимое, credentials, privacy, платежи или данные пользователя; миграция; спор, который две сильные модели не закрыли.'
}

function modelsTable(models) {
  const levels = models?.levels || models || []
  const list = Array.isArray(levels) ? levels : Object.entries(levels).map(([level, v]) => ({ level, ...v }))
  if (!list.length) return empty('Нет данных о моделях')
  return dataTable(['Уровень', 'Что значит', 'Модели'], list.map((l) => el('tr', {},
    td(el('strong', { text: l.level || l.id || '' }), 'nw'),
    td(el('span', { title: l.summary || l.meaning || '', text: LEVEL_RU[l.level || l.id] || l.summary || l.meaning || '' })),
    td(chips((l.models || l.rungs || []).map((m) => (typeof m === 'string' ? m : m.ref || m.id || m.model || JSON.stringify(m)))), 'nw'))))
}

// ── backlog of small review findings, grouped by feature ──────────────────
async function backlog() {
  const data = await api('/api/backlog')
  if (!data.configured) return page('Бэклог мелочей', data.reason || 'Бэклог мелочей не настроен.', empty('Нечего показать'))
  const holder = el('div', {})
  const toastAndReload = async (text) => {
    toast(text)
    await route()
  }
  const groupCard = (group, open) => {
    const card = el('details', { class: 'card group', open: open || undefined })
    const head = el('summary', {}, el('span', { class: 'name', text: group.feature }), el('span', { class: 'pill', text: group.count_label }), el('span', { class: 'grow' }))
    const records = group.records.map((r) => el('div', { class: 'rec' },
      el('span', { class: 'file', text: `${r.path.split('/').pop()}${r.file_line ? `:${r.file_line}` : ''}`, title: r.path }),
      el('span', {}, inlineText(r.text))))
    const confirmBox = el('div', { class: 'card preview', hidden: true })
    if (group.cleanup) {
      head.append(el('span', { class: 'pill ok', text: `уборка заведена · ${group.cleanup.id} · ${STATUS_RU[group.cleanup.status] || group.cleanup.status}` }))
    } else if (data.writable) {
      const roleSelect = el('select', { 'aria-label': 'Роль' }, (data.roles || []).map((role) => el('option', { value: role, selected: role === group.role || undefined, text: role })))
      confirmBox.append(
        el('strong', { text: 'Будет создана задача' }),
        el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Название' }), el('span', { text: `Уборка мелочей: ${group.feature} (${group.count})` })),
        el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Роль' }), el('span', {}, roleSelect, el('span', { class: 'muted small', text: ' по фиче; можно выбрать другую' }))),
        el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Что внутри' }), el('span', { text: `${group.count_label} выше с файл:строка` })),
        el('div', { class: 'row' }, el('span', { class: 'muted', text: 'Ревью' }), el('span', { text: 'один круг на весь пакет; записи убираются из бэклога, когда задача закрыта' })),
        el('div', { class: 'toolbar' },
          el('button', { type: 'button', class: 'primary', text: 'Да, завести', onclick: async (e) => {
            e.target.disabled = true
            try {
              const done = await post('/api/backlog/cleanup', { feature: group.feature, role: roleSelect.value, expect: data.expect })
              await toastAndReload(`Заведена ${done.task.id}`)
            } catch (error) {
              e.target.disabled = false
              confirmBox.append(el('div', { class: 'note bad', text: error.message }))
            }
          } }),
          el('button', { type: 'button', text: 'Отмена', onclick: () => { confirmBox.hidden = true } })))
      head.append(el('button', { type: 'button', text: 'Завести уборку', onclick: (e) => { e.preventDefault(); card.open = true; confirmBox.hidden = false } }))
    }
    card.append(head, ...records, confirmBox)
    return card
  }
  // Set through the CSSOM: the panel's content policy forbids inline style attributes.
  const fill = el('span', {})
  fill.style.width = `${Math.round(Math.min(1, data.total / data.threshold) * 100)}%`
  holder.append(
    el('div', { class: 'card' },
      el('strong', { text: `${data.total} из ${data.threshold}` }), el('span', { class: 'muted', text: ' до обязательной уборки мелочей' }),
      el('div', { class: 'meter' }, fill),
      el('div', { class: 'muted small', text: data.total >= data.threshold
        ? 'Порог достигнут: правило требует завести уборку сразу — одна задача на пакет и один круг ревью.'
        : 'На восьмой записи правило требует завести уборку сразу — одна задача на пакет и один круг ревью.' })),
    el('h2', { text: 'По фичам' }),
    ...(data.groups.length ? data.groups.map((group, i) => groupCard(group, i === 0)) : [empty('Бэклог пуст')]),
    el('p', { class: 'muted small', text: 'Группы берутся из списка фич проекта (шаблоны путей в реестре). Запись, путь которой не подошёл ни к одной фиче, попадает в группу «Без фичи».' }))
  if (!data.writable) holder.append(el('div', { class: 'note', text: 'Панель запущена без права записи: заводить уборку можно из панели, открытой из вашего терминала.' }))
  return page('Бэклог мелочей', `${data.file} — мелкие находки ревью, сгруппированные по фичам проекта.`, holder)
}

// A skill's description is written for the agent that picks it ("Use when the owner says …"): the owner gets the
// first sentence, the rest folded under "подробнее".
function brief(text) {
  const [first, ...rest] = String(text).split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ"«])/)
  if (!rest.length) return text
  return el('span', {}, first, ' ', el('details', { class: 'more' }, el('summary', { text: 'подробнее' }), el('div', { class: 'muted', text: rest.join(' ') })))
}

// Commands that add one MCP server to the vendors that do not have it yet, to copy into a terminal. Key values are
// ВАШ_КЛЮЧ: the person puts their own in. Cursor has no command — its entry goes into ~/.cursor/mcp.json.
const MCP_VENDOR_LABEL = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini (agy)', cursor: 'Cursor — запись в ~/.cursor/mcp.json' }
function mcpAddBlock(x) {
  const vendors = Object.keys(x.commands || {})
  if (!vendors.length) return el('span', { class: 'muted small', text: x.name === 'collab' ? 'регистрирует установщик' : '—' })
  return el('details', {}, el('summary', { text: `Команды (${vendors.length})` }),
    ...vendors.map((vendor) => el('div', {},
      el('div', { class: 'muted small', text: MCP_VENDOR_LABEL[vendor] || vendor }),
      command(x.commands[vendor], `команду добавления ${x.name} для ${MCP_VENDOR_LABEL[vendor] || vendor}`))),
    el('div', { class: 'muted small', text: 'Вместо ВАШ_КЛЮЧ подставьте свой ключ. После добавления перезапустите сессию агента.' }))
}

async function kit() {
  const data = await api('/api/kit')
  let tab = 'skills'
  let query = ''
  const holder = el('div', {})
  const labels = { skills: 'Скиллы', agents: 'Агенты', rules: 'Правила', mcp: 'MCP-серверы' }
  const draw = () => {
    holder.replaceChildren()
    const items = (data[tab] || []).filter((x) => `${x.name} ${x.description || ''} ${x.target || ''}`.toLowerCase().includes(query))
    // Columns per tab: an MCP server is a transport, a target and the agents that use it; the rest are a description.
    const rows = tab === 'mcp'
      ? dataTable(['Название', 'Подключение', 'Куда', 'У каких агентов', 'Добавить другим'], items.map((x) => el('tr', {},
          td(el('strong', { class: 'mono', text: x.name }), 'nw'), td(x.transport || '—', 'nw'),
          td(x.problem ? el('span', { class: 'pill bad', text: `проблема: ${x.problem}` }) : el('span', { class: 'mono small', text: x.target || '—' })),
          td((x.agents || []).join(', ') || '—', 'nw'),
          td(mcpAddBlock(x)))))
      : dataTable(tab === 'agents' ? ['Название', 'Описание', 'Модель'] : ['Название', 'Описание'], items.map((x) => el('tr', {},
          td(el('strong', { class: 'mono', text: x.name }), 'nw'),
          td(x.description ? brief(x.description) : x.problem ? `проблема: ${x.problem}` : ''),
          tab === 'agents' ? td(x.model ? el('span', { class: 'pill', text: x.model }) : '—', 'nw') : null)))
    holder.append(items.length ? rows : empty('Ничего не найдено'))
  }
  const tabs = el('div', { class: 'tabs' }, Object.keys(labels).map((key) =>
    el('button', { type: 'button', 'aria-pressed': String(key === tab), text: `${labels[key]} (${(data[key] || []).length})`, onclick: (e) => {
      tab = key
      for (const b of tabs.children) b.setAttribute('aria-pressed', String(b === e.currentTarget))
      draw()
    } })))
  const search = el('input', { type: 'search', placeholder: 'Поиск', 'aria-label': 'Поиск по набору', oninput: (e) => { query = e.target.value.trim().toLowerCase(); draw() } })
  draw()
  return page('Скиллы и агенты', 'Читается из файлов набора и пользовательских конфигов агентов (MCP — только общие, без серверов конкретных проектов): список нигде не ведётся вручную.', el('div', { class: 'toolbar' }, tabs, search), holder)
}

// ── setup wizard ──────────────────────────────────────────────────────────
async function setup() {
  let detect = await api('/api/setup/detect')
  const vendors = await vendorsNotice()
  // Start from what is written on this machine, so that "Применить" compares a change of yours against it,
  // not against the panel's guess; with nothing written, from what is installed.
  const written = detect.current?.machine?.agents ? detect.current.machine : null
  const chosen = new Set(written ? written.agents.map((a) => a.id) : detect.installed)
  let lead = written?.lead && chosen.has(written.lead) ? written.lead : detect.installed[0] || null
  let forceSingle = written?.review_mode === 'single_vendor'
  // The language agents write the owner's texts in; '' = not set (agents write as they always did).
  let ownerLanguage = written?.owner_language || ''
  let lastPlan = null // the composition the user has chosen right now, for the check
  // The roles ticked in step 4, { agentId: [role] }. null until the server has said what is written (or proposed):
  // the page never invents roles, it only changes the ones it was shown.
  let chosenRoles = null
  // The capabilities the owner confirms per agent — what the machine cannot check (running the application).
  let chosenConfirmed = null
  const sameKeys = (object, ids) => Boolean(object) && [...Object.keys(object)].sort().join(',') === [...ids].sort().join(',')
  const rolesSame = (a, b) => Object.keys(a).every((id) => [...(a[id] || [])].sort().join(',') === [...(b[id] || [])].sort().join(','))
  const out = el('div', {})
  const reviewNote = el('div', { class: 'note' })
  const terminalBox = el('div', {})
  const checkOut = el('div', {})

  let previewSeq = 0
  const drawPreview = async () => {
    // Clicks can outrun the server: only the answer to the LATEST selection may
    // be drawn, or two command sets and a wrong lastPlan would stay on screen.
    // The old steps stay on screen until the answer is here and are then swapped in one go: emptying them first made
    // the page short for a moment and the browser jumped to the top on every tick. Their buttons go dead at once,
    // though: the change they would confirm is no longer the one chosen.
    applyBox.querySelectorAll('button').forEach((button) => { button.disabled = true })
    const seq = ++previewSeq
    lastPlan = null
    const show = (...nodes) => { out.replaceChildren(...nodes) }
    terminalBox.replaceChildren()
    if (!chosen.size) {
      reviewNote.textContent = ''
      return show(el('div', { class: 'note warn', text: 'Отметьте хотя бы одного агента.' }))
    }
    if (!lead || !chosen.has(lead)) lead = [...chosen][0]
    const query = new URLSearchParams({ agents: [...chosen].join(','), lead, single_vendor: forceSingle ? '1' : '0', owner_language: ownerLanguage })
    if (!sameKeys(chosenRoles, [...chosen])) chosenRoles = null
    if (chosenRoles) query.set('roles', JSON.stringify(chosenRoles))
    if (!sameKeys(chosenConfirmed, [...chosen])) chosenConfirmed = null
    if (chosenConfirmed) query.set('confirmed', JSON.stringify(chosenConfirmed))
    let preview
    const fail = (text) => { reviewNote.textContent = ''; show(el('div', { class: 'note bad', text })) }
    try { preview = await api(`/api/setup/preview?${query}`) } catch (error) { return seq === previewSeq ? fail(error.message) : undefined }
    if (seq !== previewSeq) return
    if (!preview.ok) return fail(preview.reason)
    const apply = preview.apply || {}
    if (!chosenConfirmed && apply.confirmed && sameKeys(apply.confirmed, [...chosen])) chosenConfirmed = structuredClone(apply.confirmed)
    if (!chosenRoles && apply.roles && sameKeys(apply.roles, [...chosen])) {
      // A written role the machine now rules out starts unticked: it shows as "−" in the change, so the owner sees it
      // go and confirms it, and it no longer blocks every other change (lead, review mode).
      chosenRoles = Object.fromEntries(Object.entries(apply.roles).map(([id, list]) => [id, apply.holdable?.[id] ? list.filter((r) => apply.holdable[id].includes(r)) : list]))
      if (!rolesSame(chosenRoles, apply.roles)) return drawPreview()
    }
    // What the check compares against is what would be written: the ticked roles, not the catalog's proposal.
    lastPlan = chosenRoles
      ? { ...preview.plan, agents: preview.plan.agents.map((a) => ({ ...a, roles: chosenRoles[a.id] || a.roles })) }
      : preview.plan
    const missing = [...chosen].filter((id) => !detect.installed.includes(id))
    const missingNote = missing.length
      ? el('div', { class: 'note warn', text: `Не найдено на этой машине: ${missing.join(', ')}. Команда запишет такого агента в состав, но пользоваться им можно будет только после установки его программы.` })
      : null
    // `collab setup` writes what steps 1–3 choose (agents, lead, review mode), so it sits under step 3. When the
    // panel can write the same thing itself, the command is only the fallback and stays folded.
    terminalBox.replaceChildren(...preview.commands.filter((c) => c.command.startsWith('collab setup')).map((c) => {
      // After "Применить" the check runs by itself; after the command in a terminal the panel cannot know, so the
      // owner asks for it here, next to the command.
      const body = el('div', {}, command(c.command, 'команду настройки состава'), c.note ? el('div', { class: 'muted small', text: c.note }) : null,
        el('div', { class: 'toolbar' }, el('button', { type: 'button', text: 'Команда выполнена — проверить', onclick: runCheck })))
      const folded = detect.writable && preview.apply?.available
      return el('details', { class: 'stale', open: folded ? undefined : true }, el('summary', { text: 'Шаги 1–3 из терминала (запасной путь)' }), body)
    }))
    reviewNote.textContent = preview.plan.review_mode === 'single_vendor'
      ? 'Один вендор: ревью делает тот же вендор в отдельной сессии на другой модели, не слабее модели автора (та же модель или более слабая не подходит). Независимость ниже, это записывается в каждое ревью.'
      : 'Разные вендоры: ревью никогда не достаётся автору.'
    show(
      ...(missingNote ? [missingNote] : []),
      ...(preview.project_own_composition ? [el('div', { class: 'note warn', text: `У проекта ${preview.project_own_composition} свой состав агентов (collab/agents.json в его записи реестра): он заменяет состав машины, поэтому галочки и роли здесь меняют машину, но не этот проект.` })] : []),
      el('h2', { id: 'step-5', text: '5. Роли' }),
      rolesEditor(preview.plan, apply),
      applyBlock(preview.apply))
  }

  // Step 4: a checkbox for every role the agent can hold (its capabilities allow it), ticked when it holds it.
  // Read-only chips when the panel cannot write this composition. Gaps in independent review are shown under it:
  // with two vendors they block "Применить", with one they are notes.
  function rolesEditor(plan, apply) {
    const box = el('div', {})
    const editable = detect.writable && chosenRoles && apply.holdable
    box.append(dataTable(['Агент', 'Роли', 'Подтверждено вами'], plan.agents.map((a) => {
      const held = chosenRoles?.[a.id] || a.roles
      const head = td([el('strong', { text: a.id }), a.id === lead ? [' ', el('span', { class: 'pill', text: 'ведущий' })] : null], 'nw')
      if (!editable) return el('tr', {}, head, td(chips(held)), td('—', 'nw'))
      const facts = apply.facts?.[a.id]
      const unverified = new Set(facts?.unverified || [])
      const boxes = (apply.holdable[a.id] || []).map((role) => el('label', { class: 'chip', title: unverified.has(role) ? 'Способность для этой роли на машине не подтверждена: агент получит такие задачи последним' : null },
        el('input', { type: 'checkbox', checked: held.includes(role), onchange: (e) => {
          const next = new Set(chosenRoles[a.id])
          if (e.target.checked) next.add(role); else next.delete(role)
          chosenRoles = { ...chosenRoles, [a.id]: (apply.holdable[a.id] || []).filter((r) => next.has(r)) }
          drawPreview()
        } }), ` ${role}${unverified.has(role) ? ' · не проверено' : ''}`))
      // Roles the facts rule out are named with the reason, never offered as a checkbox.
      const blocked = (facts?.blocked || []).map((b) => el('div', { class: 'muted small', text: `${b.role} недоступна: ${b.reasons.join('; ')}` }))
      // What nothing on the machine can check, the owner confirms: running the application is the usual one. A
      // confirmed capability counts as checked, and only then may the agent say it verified the UI.
      const confirmable = Object.entries(facts?.capabilities || {})
        .filter(([, answer]) => answer.status === 'unknown' || answer.reason === 'подтверждено владельцем')
        .map(([capability]) => capability)
      const confirmBoxes = chosenConfirmed ? confirmable.map((capability) => el('label', { class: 'chip', title: 'Машина этого проверить не может: подтверждаете вы' },
        el('input', { type: 'checkbox', checked: (chosenConfirmed[a.id] || []).includes(capability), onchange: (e) => {
          const next = new Set(chosenConfirmed[a.id] || [])
          if (e.target.checked) next.add(capability); else next.delete(capability)
          chosenConfirmed = { ...chosenConfirmed, [a.id]: confirmable.filter((c) => next.has(c)) }
          drawPreview()
        } }), ` подтверждаю: ${capability}`)) : []
      return el('tr', {}, head, td([el('span', { class: 'chips' }, boxes), ...blocked]),
        td(confirmBoxes.length ? el('span', { class: 'chips' }, confirmBoxes) : '—', 'nw'))
    })))
    if (editable) box.append(el('div', { class: 'muted', text: 'Показаны только роли, для которых у агента есть нужные способности. Изменения записываются кнопкой «Применить» ниже.' }))
    // Roles an agent may hold here but does not (a composition written before "all, then cut by facts"): offered in
    // one click, still shown in "Что изменится" and written only after the confirmation.
    const missingRoles = editable ? Object.entries(apply.suggested || {}).filter(([id, list]) => list.some((r) => !(chosenRoles[id] || []).includes(r))) : []
    if (missingRoles.length) {
      box.append(el('div', { class: 'note' },
        el('span', { text: `Не выданы допустимые роли: ${missingRoles.map(([id, list]) => `${id} — ${list.join(', ')}`).join('; ')}. ` }),
        el('button', { type: 'button', text: 'Отметить все допустимые', onclick: () => {
          chosenRoles = Object.fromEntries(Object.entries(chosenRoles).map(([id, list]) => [id, (apply.holdable[id] || []).filter((r) => list.includes(r) || (apply.suggested[id] || []).includes(r))]))
          drawPreview()
        } })))
    }
    for (const p of apply.independence?.problems || []) {
      box.append(el('div', { class: 'note bad', text: `Работу роли ${p.role} у ${p.author} некому проверить, кроме автора: дайте роль ${p.reviewer_role} другому агенту.` }))
    }
    for (const n of apply.independence?.notes || []) {
      box.append(el('div', { class: 'note', text: `Один вендор: работу роли ${n.role} у ${n.author} проверит ${n.same_vendor ? 'другой агент того же вендора' : 'тот же агент в отдельной сессии'} на другой, не более слабой модели.` }))
    }
    return box
  }

  const FIELD_RU = { lead: 'ведущий', review_mode: 'режим ревью', owner_language: 'язык текстов для вас', agents: 'агенты', roles: 'роли', confirmed: 'подтверждено вами' }
  const valueRu = (field, value) => (field === 'review_mode'
    ? REVIEW_MODE_RU[value] || value || 'не записано'
    : field === 'owner_language' ? LANGUAGE_RU[value] || value || 'не задан'
    : Array.isArray(value) ? value.join(', ') || 'ничего' : value || 'не записано')
  // A list change (roles, confirmations) reads as what is added and taken away, not as two long lists.
  const isListDiff = (c) => (c.field === 'roles' || c.field === 'confirmed' || c.field === 'agents') && Array.isArray(c.from) && c.from.length
  const changeText = (c) => {
    if (!isListDiff(c)) return `${FIELD_RU[c.field] || c.field}${c.agent ? ` ${c.agent}` : ''}: ${valueRu(c.field, c.from)} → ${valueRu(c.field, c.to)}`
    const added = c.to.filter((r) => !c.from.includes(r))
    const removed = c.from.filter((r) => !c.to.includes(r))
    // The set of agents reads as "в оркестрацию: + gemini; из оркестрации: − codex".
    if (c.field === 'agents') return `агенты: ${[added.length ? `+ ${added.join(', ')} (в оркестрацию)` : '', removed.length ? `− ${removed.join(', ')} (из оркестрации)` : ''].filter(Boolean).join('; ')}`
    return `${FIELD_RU[c.field]} ${c.agent}: ${[added.length ? `+ ${added.join(', ')}` : '', removed.length ? `− ${removed.join(', ')}` : ''].filter(Boolean).join('; ')}`
  }
  // What the handover did in this project's journal, after the write.
  const handoverText = (h) => {
    if (!h) return ''
    if (!h.done) return ` ${h.reason}`
    const parts = [
      h.handed_over?.length ? `передано задач: ${h.handed_over.length} (${h.handed_over.map((t) => `${t.id} → ${t.to}`).join(', ')})` : '',
      h.queued?.length ? `в очередь (роль никто не держит): ${h.queued.length}` : '',
      h.kept?.length ? `не сдвинуто: ${h.kept.map((t) => `${t.id} (${t.status})`).join(', ')}` : ''
    ].filter(Boolean)
    return parts.length ? ` Задачи в этом проекте: ${parts.join('; ')}.` : ''
  }
  // What happens to the work of an agent taken out, said before the write: its open tasks here go to an agent that
  // holds the same role, or back to the queue when nobody does. Other projects: when a session opens there.
  const removedNotes = (info) => (info.removed_agents || []).map((id) => {
    const n = info.removed_tasks?.[id]
    const here = n === undefined ? 'открытые задачи в этом проекте посчитать не удалось' : n ? `в этом проекте у него открытых задач: ${n}` : 'в этом проекте открытых задач у него нет'
    return el('div', { class: 'note warn', text: `${id} уходит из оркестрации: ${here}. Его задачи перейдут агенту с той же ролью (у кого меньше открытых задач, при равенстве — ведущему), а если роль никто не держит — вернутся в очередь. В других проектах — при первой сессии агента там. Роли ${id} уходят вместе с ним; в каталоге он остаётся, вернуть — галочкой.` })
  })
  const applyBox = el('div', {})
  const finish = async (text) => {
    toast(text)
    detect = await api('/api/setup/detect')
    await drawPreview()
    await runCheck()
  }
  // What "Применить" shows: the exact change first, a second click to write it. The fingerprint that goes with it
  // is the file the owner was looking at, so a composition changed in the meantime is refused, not overwritten.
  function applyBlock(info) {
    applyBox.replaceChildren()
    if (!detect.writable) {
      applyBox.append(el('div', { class: 'note warn', text: 'Панель запущена без права записи (из оболочки агента или без терминала). Шаги 1–3 можно записать командой под шагом 3; язык и роли — только из панели, открытой из вашего терминала.' }))
      return applyBox
    }
    if (!info?.available) {
      applyBox.append(el('div', { class: 'note warn', text: info?.reason || 'Применить отсюда нельзя.' }))
      return applyBox
    }
    // Nothing chosen differs from what is written: the button stays, greyed, and says why — no separate sentence.
    // An earlier change is undone the same way it was made: tick the old choice and apply.
    if (!info.changes.length) {
      applyBox.append(
        el('div', { class: 'toolbar' }, el('button', { type: 'button', class: 'primary', disabled: true, text: 'Применить' }),
          el('span', { class: 'muted', text: 'Нечего применять: выбор выше совпадает с тем, что записано.' })))
      return applyBox
    }
    const confirmRow = el('div', { class: 'toolbar', hidden: true })
    // The confirmation writes exactly what "Что изменится" shows: the choice as it was when this block was drawn, not
    // whatever the boxes say by the time "Да, записать" is clicked (a tick in between redraws the block anyway).
    const shown = structuredClone({ agents: [...chosen], lead, single_vendor: forceSingle, owner_language: ownerLanguage, ...(chosenRoles ? { roles: chosenRoles } : {}), ...(chosenConfirmed ? { confirmed: chosenConfirmed } : {}), expect: info.expect })
    const apply = async () => {
      confirmRow.querySelectorAll('button').forEach((b) => { b.disabled = true })
      try {
        const done = await post('/api/setup/apply', shown)
        await finish(`Записано. Перезапустите открытые сессии агентов.${handoverText(done?.handover)}`)
      } catch (error) {
        confirmRow.querySelectorAll('button').forEach((b) => { b.disabled = false })
        applyBox.append(el('div', { class: 'note bad', text: error.message }))
      }
    }
    confirmRow.append(
      el('span', { text: info.first_setup
        ? 'Записать состав на эту машину? Панель создаст agents.json и памятки агентов; вернуть отсюда нельзя — файл удаляется вручную.'
        : 'Записать это на машину?' }),
      el('button', { type: 'button', class: 'primary', text: 'Да, записать', onclick: apply }),
      el('button', { type: 'button', text: 'Отмена', onclick: () => { confirmRow.hidden = true } }))
    applyBox.append(
      el('div', { class: 'card' }, el('strong', { text: info.first_setup ? 'Состав ещё не записан. Будет записано' : 'Что изменится' }), ...info.changes.map((c) =>
        isListDiff(c)
          ? el('div', { class: 'row' }, el('strong', { text: changeText(c) }))
          : el('div', { class: 'row' }, el('span', { text: `${FIELD_RU[c.field] || c.field}${c.agent ? ` ${c.agent}` : ''}: ` }), el('span', { class: 'muted', text: valueRu(c.field, c.from) }), el('span', { text: ' → ' }), el('strong', { text: valueRu(c.field, c.to) })))),
      ...removedNotes(info),
      el('div', { class: 'toolbar' }, el('button', { type: 'button', class: 'primary', text: info.first_setup ? 'Записать состав' : 'Применить', onclick: () => { confirmRow.hidden = false } })),
      confirmRow)
    return applyBox
  }

  // Two separate answers, so that "nothing is broken" is never read as "your
  // choice is applied": first what is recorded on this machine against what was
  // chosen above, then the general health of the kit.
  const compareBlock = (machine) => {
    if (!lastPlan) return [el('div', { class: 'note warn', text: 'Выбор выше неполный, сравнивать не с чем.' })]
    if (!machine) return [el('div', { class: 'note warn', text: 'Не применено: на этой машине состав ещё не записан. Выполните команду под шагом 3 в терминале и проверьте снова.' })]
    if (machine.problem) return [el('div', { class: 'note bad', text: `Файл состава на машине не читается: ${machine.problem}` })]
    const want = new Set(lastPlan.agents.map((a) => a.id))
    const have = new Set(machine.agents.map((a) => a.id))
    const mismatches = []
    if (machine.lead !== lastPlan.lead) mismatches.push(`ведущий: записан ${machine.lead || 'никто'}, выбран ${lastPlan.lead}`)
    if (machine.review_mode !== lastPlan.review_mode) mismatches.push(`режим ревью: записан «${REVIEW_MODE_RU[machine.review_mode] || machine.review_mode || '—'}», выбран «${REVIEW_MODE_RU[lastPlan.review_mode] || lastPlan.review_mode}»`)
    if ((machine.owner_language || '') !== ownerLanguage) mismatches.push(`язык текстов: записан «${LANGUAGE_RU[machine.owner_language] || machine.owner_language || 'не задан'}», выбран «${LANGUAGE_RU[ownerLanguage] || ownerLanguage || 'не задан'}»`)
    const missing = [...want].filter((id) => !have.has(id))
    const extra = [...have].filter((id) => !want.has(id))
    if (missing.length) mismatches.push(`нет на машине: ${missing.join(', ')}`)
    if (extra.length) mismatches.push(`записано лишнее: ${extra.join(', ')}`)
    // "Exactly this composition" includes who holds which role.
    for (const wanted of lastPlan.agents) {
      const recorded = machine.agents.find((a) => a.id === wanted.id)
      if (!recorded) continue
      const same = wanted.roles.length === recorded.roles.length && wanted.roles.every((role) => recorded.roles.includes(role))
      if (!same) mismatches.push(`роли ${wanted.id}: записаны «${recorded.roles.join(', ') || 'никаких'}», выбраны «${wanted.roles.join(', ')}»`)
    }
    return mismatches.length
      ? [el('div', { class: 'note warn', text: 'Не применено: записанный состав отличается от выбранного.' }), ...mismatches.map((m) => el('div', { class: 'muted small', text: `• ${m}` }))]
      : [el('div', { class: 'note ok', text: 'Применено: на машине записан именно этот состав. Перезапустите открытые сессии агентов, чтобы они его подхватили.' })]
  }

  const runCheck = async () => {
    checkOut.replaceChildren(el('h2', { text: 'Проверка' }), el('div', { class: 'muted', text: 'Проверяю…' }))
    // The answer lands at the bottom of the wizard, far from the button that asked for it.
    checkOut.scrollIntoView({ behavior: 'auto', block: 'start' })
    try {
      const [now, doc] = await Promise.all([api('/api/setup/detect'), api('/api/setup/check')])
      const problems = [...(doc.unheld_roles || []).map((r) => `Роль без исполнителя: ${r}`),
        ...(doc.orphaned_tasks || []).map((t) => `Задача ${t.id} ждёт роль ${t.role}, которой ни у кого нет, и никем не будет взята: ${t.title}`),
        ...(doc.suspended_roles || []).map((s) => `${s.agent} приостановил роль ${s.role}: ${s.reason}. Вернуть: ${s.restore}. Отобрать насовсем: снимите роль выше и примените.`), ...(doc.agents || []).filter((a) => a.available === false || a.ok === false).map((a) => `Агент ${a.id}: ${a.reason || a.how || 'недоступен'}`)]
      checkOut.replaceChildren(
        el('h2', { text: 'Проверка' }),
        el('h3', { text: 'Записан ли выбранный состав' }), ...compareBlock(now.current?.machine),
        el('h3', { text: 'Общее состояние набора (не зависит от выбора выше)' }),
        ...(problems.length ? problems.map((p) => el('div', { class: 'note warn', text: p })) : [el('div', { class: 'note', text: 'Проблем не найдено.' })]))
    } catch (error) {
      checkOut.replaceChildren(el('h2', { text: 'Проверка' }), el('div', { class: 'note bad', text: error.message }))
    }
  }

  // An agent whose program is not on this machine is not offered: the composition is this machine's, and an agent
  // ticked here that cannot run here only confuses the routing. It is listed, folded, with how to install it — so a
  // program the kit failed to find is still visible. One already written in the composition stays tickable, so it can
  // be taken out.
  const writtenIds = new Set(written ? written.agents.map((a) => a.id) : [])
  const notLaunchable = (id) => Array.isArray(detect.launchable) && !detect.launchable.includes(id)
  const unledAgents = (ids, leadId) => unledWithoutCli(ids, leadId, detect.launchable)
  const choice = (a) => {
    const installed = detect.installed.includes(a.id)
    const box = el('input', { type: 'checkbox', id: `ag-${a.id}`, checked: chosen.has(a.id), onchange: (e) => {
      if (e.target.checked) chosen.add(a.id); else chosen.delete(a.id)
      drawLead(); drawPreview()
    } })
    const pill = installed
      ? el('span', { class: 'pill ok', text: 'найден на машине' })
      : el('span', { class: 'pill warn', text: 'записан в составе, но на машине не найден' })
    // Installed but without a command another agent could start it with: it may lead, it cannot be led.
    const noCli = installed && notLaunchable(a.id)
      ? [' ', el('span', { class: 'pill warn', text: 'без CLI запуска', title: 'Может быть ведущим: сам запускает остальных. Подчинённым — только вручную: ведущий не сможет его запустить, задачи будут ждать во входящих, пока вы сами его не откроете.' })]
      : null
    return el('label', { class: 'choice', for: `ag-${a.id}` }, box, el('span', {}, el('strong', { text: a.name || a.id }), ' ', pill, noCli, el('div', { class: 'muted', text: a.provider || '' })))
  }
  const offered = detect.catalog.filter((a) => detect.installed.includes(a.id) || writtenIds.has(a.id))
  const absent = detect.catalog.filter((a) => !offered.includes(a))
  const agentsBox = el('div', {},
    offered.length ? el('div', { class: 'list' }, offered.map(choice)) : el('div', { class: 'note warn', text: 'На этой машине не найден ни один агент из каталога. Установите хотя бы одного (подсказки ниже), откройте его один раз и обновите страницу.' }),
    absent.length
      ? el('details', { class: 'stale' }, el('summary', { text: `Не найдены на этой машине (${absent.length}): ${absent.map((a) => a.name_ru || a.name || a.id).join(', ')}` }),
          el('div', { class: 'list' }, absent.map((a) => el('div', { class: 'row' },
            el('span', { class: 'grow' }, el('strong', { text: a.name_ru || a.name || a.id }), el('div', { class: 'muted small', text: a.install_hint_ru || a.install_hint ||'Установите программу этого агента и откройте её один раз, потом обновите страницу.' }))))))
      : null)
  const leadBox = el('div', { class: 'list' })
  function drawLead() {
    leadBox.replaceChildren()
    if (!chosen.has(lead)) lead = [...chosen][0] || null
    for (const id of chosen) {
      const radio = el('input', { type: 'radio', name: 'lead', id: `ld-${id}`, checked: id === lead, onchange: () => { lead = id; drawLead(); drawPreview() } })
      const agent = detect.catalog.find((a) => a.id === id)
      leadBox.append(el('label', { class: 'choice', for: `ld-${id}` }, radio, el('span', {}, el('strong', { text: id }), el('span', { class: 'muted', text: agent ? ` · ${agent.provider || ''}` : '' }))))
    }
    // The lead starts the others through their command-line programs. A chosen agent without one is fine as the
    // lead, but as a subordinate nothing can start it: say so here, where the lead is chosen. Nothing is refused.
    for (const id of unledAgents(chosen, lead)) {
      const name = detect.catalog.find((a) => a.id === id)?.name || id
      leadBox.append(el('div', { class: 'note warn', text: `${name}: на машине нет CLI, через который ведущий (${lead}) мог бы его запустить. Задачи и ревью для него будут ждать во входящих, пока вы сами не откроете ${name} и не попросите забрать работу. Ведущим он быть может — тогда остальных запускает он.` }))
    }
  }
  const single = el('label', { class: 'choice' }, el('input', { type: 'checkbox', checked: forceSingle, onchange: (e) => { forceSingle = e.target.checked; drawPreview() } }), el('span', {}, el('span', { text: 'Ревью только внутри одного вендора' }), el('div', { class: 'muted', text: 'Включайте, если второго вендора нет или он недоступен: ревью сделает тот же вендор в отдельной сессии на другой, не более слабой модели. Сами агенты остаются разными, меняется только режим ревью.' })))
  // Step 4: which language the agents write the owner's texts in. A language written by hand that is not offered
  // here is still shown and kept, never silently dropped.
  const languageOptions = [['', 'Не задан — агенты пишут как привыкли'], ['ru', 'Русский'], ['en', 'Английский']]
  if (ownerLanguage && !languageOptions.some(([code]) => code === ownerLanguage)) languageOptions.push([ownerLanguage, ownerLanguage])
  const languageBox = el('div', { class: 'list' }, languageOptions.map(([code, label]) => el('label', { class: 'choice', for: `lang-${code || 'none'}` },
    el('input', { type: 'radio', name: 'owner-language', id: `lang-${code || 'none'}`, checked: code === ownerLanguage, onchange: () => { ownerLanguage = code; drawPreview() } }),
    el('span', { text: label }))))
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' })
  drawLead(); drawPreview()
  return page('Мастер настройки', 'Отметьте, кто работает в оркестрации, выберите ведущего, режим ревью и роли — и примените кнопкой. Агента без галочки в оркестрации нет, но он остаётся в каталоге.',
    // A plain table of contents: it jumps to a step, it does not claim progress.
    el('nav', { class: 'steps', 'aria-label': 'Шаги мастера' }, ['Кто участвует', 'Ведущий', 'Режим ревью', 'Язык', 'Роли'].map((s, i) =>
      el('button', { type: 'button', class: 'chip', onclick: () => jump(`step-${i + 1}`), text: `${i + 1}. ${s}` }))),
    el('h2', { id: 'step-1', text: '1. Кто участвует' }), agentsBox, vendors,
    el('h2', { id: 'step-2', text: '2. Кто ведущий' }), el('p', { class: 'sub', text: 'Ведущий — агент, в котором вы сами работаете; он распределяет работу, остальные берут задачи через журнал.' }), leadBox,
    el('h2', { id: 'step-3', text: '3. Режим ревью' }), reviewNote, single, terminalBox,
    el('h2', { id: 'step-4', text: '4. Язык текстов для вас' }),
    el('p', { class: 'sub', text: 'На этом языке агенты пишут то, что читаете вы: заголовки и описания задач, итоги, сообщения, ревью и находки. Код, пути, команды и цитаты остаются как есть. Уже записанные тексты не переводятся.' }),
    languageBox,
    out, checkOut)
}

// Shown on the overview only while the panel looks at the folder it was started in and that folder is not
// connected: a project picked in the switcher is connected by definition. The wizard configures the machine and
// has no project of its own, so this lives here and not there.
async function connectHint() {
  if (PROJECT) return null
  const data = await api('/api/projects').catch(() => null)
  if (!data || data.started !== null) return null
  return el('div', { class: 'note warn' },
    el('div', { text: 'Эта папка не подключена к набору: агенты работают здесь без настроек проекта.' }),
    el('p', { class: 'sub', text: 'Посмотреть, что запишет подключение (ничего не пишет):' }),
    command('collab connect --dry-run', 'команду просмотра подключения'),
    el('div', { class: 'muted', text: 'Подключить — команда collab connect без --dry-run, в терминале этой папки.' }))
}

// ── routing ───────────────────────────────────────────────────────────────
// The raw event feed is gone from the panel (01.10.2026): it repeated what the task pages say, with ids instead of
// names. The events stay in the journal; `collab log` reads them in a terminal. An old #/events link opens the overview.
const ROUTES = { overview, tasks, waiting, roster, kit, backlog, setup }

let badgeSeq = 0 // an older answer that arrives late must not overwrite a newer count

async function refreshBadge() {
  const mine = ++badgeSeq
  try {
    const w = await api('/api/waiting')
    if (mine !== badgeSeq) return
    // A task waiting for the owner counts once, whatever its approval's state (an expired one still needs the owner to
    // ask the agent again or close it); a live approval of no such task counts on its own. Expired approvals do not.
    const waitingTaskIds = new Set((w.tasks || []).map((t) => t.id))
    const loose = (w.approvals || []).filter((a) => !a.expired && !waitingTaskIds.has(a.task_id)).length
    const n = waitingTaskIds.size + loose + (w.decisions?.length || 0)
    const badge = document.getElementById('waiting-count')
    badge.textContent = String(n)
    badge.hidden = n === 0
  } catch { /* the badge is a convenience; the screens report real errors */ }
}

const TITLES = { overview: 'Обзор', tasks: 'Задачи', waiting: 'Ждёт вас', roster: 'Состав', kit: 'Скиллы и агенты', backlog: 'Бэклог мелочей', setup: 'Мастер настройки' }

async function route() {
  const seq = ++routeSeq
  const [name = 'overview', ...rest] = location.hash.replace(/^#\//, '').split('?')[0].split('/')
  const screen = ROUTES[name] || overview
  for (const link of document.querySelectorAll('[data-route]')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current')
  }
  main.replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }))
  let nodes
  try {
    nodes = await screen(rest.length ? decodeURIComponent(rest.join('/')) : undefined)
  } catch (error) {
    nodes = seq === routeSeq ? failure(error) : null
  }
  // Somebody navigated again while this screen was loading: its result is stale.
  if (seq !== routeSeq) return
  main.replaceChildren(...[nodes].flat(3).filter(Boolean))
  document.title = `${TITLES[name] || TITLES.overview} · Agent Collab Kit`
  main.focus({ preventScroll: true })
  refreshBadge()
}

// The token is kept out of the address bar (history) once read and stored; see PANEL_TOKEN. Without sessionStorage it
// stays, or a reload would leave the page without it. The chosen project stays in the address either way.
const tokenKept = (() => {
  try { return sessionStorage.getItem('panel_token') === PANEL_TOKEN } catch { return false }
})()
if (new URL(location.href).searchParams.has('t') && tokenKept) {
  history.replaceState(null, '', location.pathname + (PROJECT ? `?project=${encodeURIComponent(PROJECT)}` : '') + location.hash)
}

// The switcher: the connected projects of the registry. Choosing one reloads the page on it — every screen then
// reads that project's journal. A project with no journal yet is listed but cannot be chosen.
async function drawProjectSwitch() {
  const box = document.getElementById('project-switch')
  if (!box) return
  let data
  try {
    data = await api('/api/projects')
  } catch {
    return // the panel still works on the project it was started in
  }
  const list = data.projects || []
  if (!list.length && data.started === null && !data.unusable) return
  // The token normally lives in sessionStorage; where that is unavailable it must stay in the address, or the reload
  // that a switch makes would leave the page without it.
  const tokenStored = (() => {
    try { return sessionStorage.getItem('panel_token') === PANEL_TOKEN } catch { return false }
  })()
  const options = [
    // Started in a folder that is not a connected project: its own entry, so its data is never shown under another
    // project's name.
    ...(data.started === null ? [el('option', { value: '', selected: !PROJECT, text: 'эта папка (не подключена)' })] : []),
    // The chosen project cannot be used any more: shown as such, and another one can be chosen.
    ...(data.unusable && PROJECT ? [el('option', { value: PROJECT, selected: true, disabled: true, text: `${PROJECT} — недоступен` })] : []),
    ...list.map((project) => el('option', {
      value: project.id,
      selected: !data.unusable && project.id === data.selected,
      disabled: !project.present || !project.initialized,
      text: `${project.id}${!project.present ? ' — нет на этой машине' : !project.initialized ? ' — журнала нет (collab init)' : ''}`
    }))
  ]
  const select = el('select', { id: 'project-select', 'aria-label': 'Проект', onchange: (event) => {
    const id = event.target.value
    const url = new URL(location.href)
    url.search = ''
    if (id && id !== data.started) url.searchParams.set('project', id)
    if (!tokenStored) url.searchParams.set('t', PANEL_TOKEN)
    location.assign(url.pathname + url.search + location.hash)
  } }, options)
  // With nothing else to choose, a drop-down that switches nowhere looks broken: the project is shown as text, with how
  // to connect another. (And replaceChildren prints null as the word "null", so absent parts are filtered out.)
  const choosable = options.filter((option) => !option.disabled)
  const body = choosable.length > 1 || data.unusable
    ? [select]
    : [el('div', { class: 'project-name', text: choosable[0]?.textContent || PROJECT || '—' }),
        el('div', { class: 'muted small', text: 'Другой проект появится здесь после collab connect в его папке.' })]
  box.replaceChildren(...[
    el('div', { class: 'nav-title', text: 'Проект' }),
    ...body,
    data.unusable ? el('div', { class: 'muted small', text: `${data.unusable}. Выберите другой проект.` }) : null
  ].filter(Boolean))
}

window.addEventListener('hashchange', route)
drawProjectSwitch()
route()
