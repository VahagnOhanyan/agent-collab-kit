// Agent Collab Kit panel: read-only views over the collab journal and the kit files.
// Everything the journal contains was written by agents, so it is untrusted:
// every value goes into the page through textContent, never as markup.
'use strict'

const main = document.getElementById('main')
const toastBox = document.getElementById('toast')
let stream = null
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
  for (const child of children.flat()) {
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
  changes_requested: 'warn', waiting_for_user: 'warn', waiting_for_agent: 'warn', pending: 'warn', busy: 'warn', waiting: 'warn'
}
// Values the ledger stores as English words are shown in Russian; the raw value
// stays in the tooltip, because it is what the terminal commands and logs use.
const STATUS_RU = {
  completed: 'завершена', cancelled: 'отменена', created: 'создана', approved: 'одобрена', changes_requested: 'нужны правки',
  blocked: 'заблокирована', waiting_for_user: 'ждёт вас', waiting_for_agent: 'ждёт агента', in_progress: 'в работе', review: 'на ревью',
  pending: 'ожидает', available: 'доступен', offline: 'не в сети', busy: 'занят', waiting: 'ждёт', failed: 'упало', granted: 'выдано',
  rejected: 'отклонено', open: 'открыто', disputed: 'спор', escalated: 'передано владельцу', decided: 'решено', resolved: 'решено'
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

// Unfinished delegations on open tasks, newest first: five in view, the rest folded. The lead declares them; the
// journal does not check them, which the tooltip says instead of the heading.
function delegationsBlock(list) {
  const sorted = [...list].sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
  const row = (d) => el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(d.task_id)}` },
    el('span', { class: 'mono', text: `${d.by} → ${d.to}` }), el('span', { class: 'pill', text: `${d.model}${d.level ? ` · ${d.level}` : ''}` }),
    el('span', { class: 'grow', text: d.purpose || d.task_title || '' }), el('span', { class: 'muted small', text: when(d.started_at) }))
  const rest = sorted.slice(5)
  return [el('h2', { text: 'Делегирование', title: 'Записи ведущего о том, кому он отдал работу; журнал их не проверяет' }),
    el('div', { class: 'list' }, sorted.slice(0, 5).map(row)),
    rest.length ? el('details', { class: 'stale' }, el('summary', { text: `ещё ${rest.length}` }), el('div', { class: 'list' }, rest.map(row))) : null]
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
      tile(s.decisions_open, 'открытых решений', s.decisions_open > 0, '#/waiting'),
      tile(s.reviews_pending, 'ревью в очереди', false, '#/waiting'),
      tile(s.runs_failed, 'проверок не проходят сейчас', s.runs_failed > 0)),
    vendors,
    el('h2', { text: 'Агенты' }),
    el('div', { class: 'list' }, s.agents.map((a) =>
      el('div', { class: 'row' }, pill(a.status), el('strong', { class: 'grow', text: a.id }),
        a.current_task_id ? el('a', { href: `#/tasks/${encodeURIComponent(a.current_task_id)}`, class: 'mono', text: a.current_task_id }) : null))),
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
  const list = status ? everything.filter((t) => t.status === status) : all ? everything : everything.filter(isOpen)
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
  const rows = list.map((t) => ({
    text: `${t.id} ${t.title} ${t.owner || ''} ${t.status} ${statusText(t.status)} ${t.standstill ? `${STANDSTILL_RU[t.standstill.code] || ''} ${t.standstill.detail}` : ''}`.toLowerCase(),
    node: el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(t.id)}` }, pill(t.status),
      el('span', { class: 'grow' }, t.title,
        t.standstill && !QUIET.has(t.standstill.code)
          ? el('div', { class: 'muted small' }, STANDSTILL_RU[t.standstill.code] === statusText(t.status) ? null : [standstillPill(t.standstill), ' '], t.standstill.detail)
          : null),
      el('span', { class: 'mono muted', text: t.owner || 'без исполнителя' }))
  }))
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
  return page('Задачи', status ? `Задачи со статусом «${statusText(status)}»` : all ? 'Все задачи' : 'Открытые задачи', toggle, el('div', { class: 'toolbar' }, search, count),
    list.length ? el('div', { class: 'list' }, rows.map((row) => row.node)) : empty('Задач нет'), none)
}

const TERMINAL = new Set(['completed', 'cancelled'])

async function taskDetail(id) {
  const data = await api(`/api/tasks/${encodeURIComponent(id)}`)
  const t = data.task
  const section = (title, items, render) => [el('h2', { text: title }), items?.length ? el('div', { class: 'list' }, items.map(render)) : empty('—')]
  return page(t.title, `${t.id} · ${t.owner || 'без исполнителя'} · ${t.role || 'роль не указана'}`,
    // Back goes to the list the task can be found in: a closed task is not in the open-only list.
    el('div', { class: 'toolbar' }, pill(t.status), el('a', { href: TERMINAL.has(t.status) ? '#/tasks?all=1' : '#/tasks', text: '← к списку задач' })),
    data.standstill
      ? el('div', { class: `note ${STANDSTILL_TONE[data.standstill.code] === 'bad' ? 'bad' : 'warn'}` },
          el('strong', { text: `Почему не завершена: ${STANDSTILL_RU[data.standstill.code] || data.standstill.code}` }), el('br'),
          data.standstill.detail,
          ...(data.standstill.obstacles || []).filter((o) => o !== data.standstill.detail).flatMap((o) => [el('br'), `Мешает закрытию: ${o}`]))
      : null,
    t.blocked_reason ? el('div', { class: 'note bad', text: `Заблокирована: ${plain(t.blocked_reason)}` }) : null,
    t.waiting_on && !TERMINAL.has(t.status) ? el('div', { class: 'note warn', text: `Ждёт: ${plain(t.waiting_on)}` }) : null,
    t.completion_summary ? [el('h2', { text: 'Итог' }), el('div', { class: 'card' }, prose(t.completion_summary))] : null,
    t.description ? el('div', { class: 'card' }, prose(t.description)) : null,
    t.spec?.acceptance_criteria?.length ? [el('h2', { text: 'Критерии приёмки' }), el('div', { class: 'card' }, t.spec.acceptance_criteria.map((c) => el('div', { text: `• ${c}` })))] : null,
    // The verdict alone is not the review: what the reviewer found is the point.
    [el('h2', { text: 'Ревью' }), data.reviews?.length ? data.reviews.map(reviewCard) : empty('—')],
    // The outcome is the lead's free-text report, often a paragraph: it goes under the purpose and wraps. As a
    // no-wrap pill it pushed the row off the page and squeezed the purpose to one letter per line.
    section('Делегирование', data.delegations || t.delegations, (d) => el('div', { class: 'row' }, el('span', { class: 'mono', text: `${d.by || ''} → ${d.to || ''}` }), el('span', { class: 'pill', text: d.model || '' }),
      el('span', { class: 'grow' }, el('div', { text: d.purpose || '' }), d.outcome ? el('div', { class: 'muted', text: d.outcome }) : null),
      d.outcome ? null : pill('идёт'))),
    section('Прогоны проверок', t.runs, (r) => el('div', { class: 'row' }, runPill(r.status), el('span', { class: 'mono', text: r.runner }), el('span', { class: 'grow', text: r.headline || '' }))),
    section('Сообщения', data.messages, (m) => el('div', { class: 'row msg' },
      el('span', { class: 'mono muted', text: `${m.from_agent || '?'} · ${when(m.created_at)}` }),
      el('span', { class: 'grow' }, m.subject ? el('strong', { text: m.subject }) : null, m.body ? prose(m.body) : null))),
    t.files?.length ? [el('h2', { text: 'Файлы задачи' }), el('div', { class: 'card mono', text: t.files.join('\n') })] : null)
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

// What the owner needs to judge a request: the action, what it costs, why it is
// asked, until when it holds, and both ways to answer it.
function approvalCard(x) {
  return el('div', { class: 'card' },
    el('div', {}, el('strong', { text: x.action?.summary || x.id }), ' ', el('span', { class: 'pill warn', text: x.action_class || '' })),
    x.policy_reason ? el('div', { class: 'muted small', text: x.policy_reason }) : null,
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
    x.task_id ? el('a', { class: 'mono small', href: `#/tasks/${encodeURIComponent(x.task_id)}`, text: `задача ${x.task_id}` }) : null,
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
  return page('Ждёт вас', 'Одобрения и решения выдаются только в терминале: панель их показывает, но не выдаёт.',
    el('h2', { text: `Одобрения (${live.length})` }),
    live.length ? live.map(approvalCard) : empty('Нет одобрений, которые можно выдать'),
    // Expired requests are not work for the owner: they are kept apart and folded,
    // so a long tail of them does not bury the live ones.
    stale.length
      ? el('details', { class: 'stale' }, el('summary', { text: `Просроченные одобрения (${stale.length}): выдать их уже нельзя, агент должен запросить заново` }), ...stale.map(approvalCard))
      : null,
    el('h2', { text: `Решения (${d.length})` }),
    d.length ? d.map(decisionCard) : empty('Нет открытых споров'),
    el('h2', { text: `Ревью в очереди (${r.length})` }),
    r.length ? el('div', { class: 'list' }, r.map((x) => el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(x.task_id)}` }, pill('pending'), el('span', { class: 'grow', text: `${slotText(x)}${x.reviewer || x.requested_role || x.reviewer_role ? ` · ждёт ${x.reviewer || x.requested_role || x.reviewer_role}` : ''}` }), el('span', { class: 'mono muted', text: x.task_id })))) : empty('Очередь пуста'))
}

const EVENT_RU = {
  'agent.status': 'агент: статус', 'agent.exit': 'агент вышел', 'agent.role_suspended': 'агент приостановил роль', 'agent.role_restored': 'роль возвращена',
  'approval.requested': 'запрошено одобрение', 'approval.resolved': 'ответ на одобрение', 'approval.consumed': 'одобрение использовано',
  'decision.created': 'открыт спор', 'decision.position': 'позиция в споре', 'decision.escalated': 'спор передан вам', 'decision.resolved': 'спор решён',
  'message.sent': 'сообщение',
  'review.requested': 'запрошено ревью', 'review.submitted': 'ревью сдано', 'review.released': 'ревью снято', 'review.handed_over': 'ревью передано',
  'run.started': 'проверка запущена', 'run.finished': 'проверка завершена',
  'task.created': 'задача создана', 'task.updated': 'задача обновлена', 'task.assigned': 'задача назначена', 'task.claimed': 'задача взята',
  'task.released': 'задача отпущена', 'task.completed': 'задача завершена', 'task.handed_over': 'задача передана', 'task.lease_expired': 'аренда задачи истекла',
  'task.files_claimed': 'файлы закреплены', 'task.delegated': 'делегирование', 'task.delegation_closed': 'делегирование закрыто'
}

async function events() {
  const mine = routeSeq
  const initial = await api('/api/events?limit=100')
  // The owner may have moved on while the request was in flight; a superseded
  // screen must not open a stream nobody will close.
  if (mine !== routeSeq) return []
  const box = el('div', { class: 'log', id: 'log', tabindex: '0', role: 'log', 'aria-label': 'Лента событий' })
  const emptyNote = el('div', { class: 'empty', text: 'В журнале пока нет событий', hidden: initial.length > 0 })
  const noMatch = el('div', { class: 'empty', text: 'Ни одно событие не подходит под фильтр', hidden: true })
  let filter = ''
  const rows = []
  // Recomputed on every change — a filter typed earlier and an event arriving later both move it.
  const updateNoMatch = () => {
    noMatch.hidden = !filter || rows.length === 0 || rows.some((row) => !row.node.hidden)
  }
  // Newest on top: a new event is put first, so the owner sees it without scrolling; one read lower stays put.
  const render = (event) => {
    const node = el('details', { class: 'ev' },
      el('summary', {}, el('span', { class: 't', text: when(event.ts, { seconds: true }) }), el('span', { class: 'ty', title: event.type, text: EVENT_RU[event.type] || event.type }), el('span', { text: [event.actor, event.subject?.id].filter((v, i, all) => v && all.indexOf(v) === i).join(' · ') })),
      el('pre', { text: JSON.stringify(event.data ?? {}, null, 2) }))
    rows.push({ node, text: `${event.type} ${EVENT_RU[event.type] || ''} ${event.actor} ${event.subject?.id} ${JSON.stringify(event.data ?? {})}`.toLowerCase() })
    node.hidden = Boolean(filter) && !rows[rows.length - 1].text.includes(filter)
    box.prepend(node)
    emptyNote.hidden = true
    updateNoMatch()
  }
  initial.forEach(render)
  const search = el('input', { type: 'search', placeholder: 'Фильтр', 'aria-label': 'Фильтр событий', oninput: (e) => {
    filter = e.target.value.trim().toLowerCase()
    for (const row of rows) row.node.hidden = Boolean(filter) && !row.text.includes(filter)
    updateNoMatch()
  } })
  closeStream()
  stream = new EventSource(withProject(`/api/stream?t=${encodeURIComponent(PANEL_TOKEN)}`)) // EventSource cannot send headers
  stream.onmessage = (message) => {
    try { render(JSON.parse(message.data)) } catch { /* a malformed line is skipped, the stream goes on */ }
  }
  setConn('', 'подключаюсь…')
  stream.onopen = () => setConn('ok', 'обновляется вживую')
  stream.onerror = () => setConn('warn', 'связь потеряна, переподключаюсь…')
  return page('Лента', 'События журнала, новые сверху. Нажмите на событие, чтобы увидеть подробности.', el('div', { class: 'toolbar' }, search), emptyNote, noMatch, box)
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
  return el('div', { class: 'list' }, list.map((l) =>
    el('div', { class: 'row' }, el('strong', { text: l.level || l.id || '' }), el('span', { class: 'grow', title: l.summary || l.meaning || '', text: LEVEL_RU[l.level || l.id] || l.summary || l.meaning || '' }),
      chips((l.models || l.rungs || []).map((m) => (typeof m === 'string' ? m : m.ref || m.id || m.model || JSON.stringify(m)))))))
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

async function kit() {
  const data = await api('/api/kit')
  let tab = 'skills'
  let query = ''
  const holder = el('div', {})
  const labels = { skills: 'Скиллы', agents: 'Агенты', rules: 'Правила', mcp: 'MCP-серверы' }
  const draw = () => {
    holder.replaceChildren()
    const items = (data[tab] || []).filter((x) => `${x.name} ${x.description || ''} ${x.target || ''}`.toLowerCase().includes(query))
    holder.append(items.length ? el('div', { class: 'list' }, items.map((x) =>
      el('div', { class: 'row' }, el('strong', { class: 'mono', text: x.name }), el('span', { class: 'grow' }, x.description ? brief(x.description) : (x.agents ? `${x.transport}: ${x.target || '—'} · ${x.agents.join(', ')}` : x.problem ? `проблема: ${x.problem}` : '')),
        x.model ? el('span', { class: 'pill', text: x.model }) : null))) : empty('Ничего не найдено'))
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
    box.append(el('div', { class: 'list' }, plan.agents.map((a) => {
      const held = chosenRoles?.[a.id] || a.roles
      const head = [el('strong', { text: a.id }), a.id === lead ? el('span', { class: 'pill', text: 'ведущий' }) : null]
      if (!editable) return el('div', { class: 'row' }, ...head, el('span', { class: 'grow' }, chips(held)))
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
      return el('div', { class: 'row' }, ...head, el('span', { class: 'grow' }, el('span', { class: 'chips' }, boxes),
        confirmBoxes.length ? el('span', { class: 'chips' }, confirmBoxes) : null, ...blocked))
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

  const agentsBox = el('div', { class: 'list' }, detect.catalog.map((a) => {
    const installed = detect.installed.includes(a.id)
    const box = el('input', { type: 'checkbox', id: `ag-${a.id}`, checked: chosen.has(a.id), onchange: (e) => {
      if (e.target.checked) chosen.add(a.id); else chosen.delete(a.id)
      drawLead(); drawPreview()
    } })
    return el('label', { class: 'choice', for: `ag-${a.id}` }, box, el('span', {}, el('strong', { text: a.name || a.id }), ' ', el('span', { class: `pill ${installed ? 'ok' : ''}`, text: installed ? 'найден на машине' : 'не найден' }), el('div', { class: 'muted', text: `${a.provider || ''} · ${(a.roles || []).join(', ')}` })))
  }))
  const leadBox = el('div', { class: 'list' })
  function drawLead() {
    leadBox.replaceChildren()
    if (!chosen.has(lead)) lead = [...chosen][0] || null
    for (const id of chosen) {
      const radio = el('input', { type: 'radio', name: 'lead', id: `ld-${id}`, checked: id === lead, onchange: () => { lead = id; drawPreview() } })
      const agent = detect.catalog.find((a) => a.id === id)
      leadBox.append(el('label', { class: 'choice', for: `ld-${id}` }, radio, el('span', {}, el('strong', { text: id }), el('span', { class: 'muted', text: agent ? ` · ${agent.provider || ''}` : '' }))))
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
const ROUTES = { overview, tasks, waiting, events, roster, kit, backlog, setup }

function closeStream() {
  if (stream) { stream.close(); stream = null }
}
// The live-stream state, shown only while a screen holds a stream (the feed); elsewhere there is nothing to report.
function setConn(tone, text) {
  document.getElementById('conn').hidden = !text
  document.getElementById('conn-dot').className = `dot ${tone}`
  document.getElementById('conn-text').textContent = text
}

let badgeSeq = 0 // an older answer that arrives late must not overwrite a newer count

async function refreshBadge() {
  const mine = ++badgeSeq
  try {
    const w = await api('/api/waiting')
    if (mine !== badgeSeq) return
    // An expired approval cannot be granted any more; it is not "waiting for you".
    const n = (w.approvals || []).filter((a) => !a.expired).length + (w.decisions?.length || 0)
    const badge = document.getElementById('waiting-count')
    badge.textContent = String(n)
    badge.hidden = n === 0
  } catch { /* the badge is a convenience; the screens report real errors */ }
}

const TITLES = { overview: 'Обзор', tasks: 'Задачи', waiting: 'Ждёт вас', events: 'Лента', roster: 'Состав', kit: 'Скиллы и агенты', backlog: 'Бэклог мелочей', setup: 'Мастер настройки' }

async function route() {
  const seq = ++routeSeq
  closeStream()
  setConn('', '')
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

// The switcher: the connected projects of the registry. Choosing one reloads the page on it — every screen and the
// event stream then read that project's journal. A project with no journal yet is listed but cannot be chosen.
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
