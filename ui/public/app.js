// Agent Kit panel: read-only views over the collab journal and the kit files.
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

async function api(path) {
  const response = await fetch(path, { credentials: 'omit', headers: { accept: 'application/json', 'x-panel-token': PANEL_TOKEN } })
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
const REVIEW_MODE_RU ={ cross_vendor: 'ревью другой модельной семьёй', single_vendor: 'ревью той же модельной семьёй' }
const statusText = (status) => (status === undefined || status === null ? '—' : STATUS_RU[status] || status)
const pill = (status) => el('span', { class: `pill ${STATUS_TONE[status] || ''}`, title: status ?? '', text: statusText(status) })
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—')
const chips = (list) => el('div', { class: 'chips' }, (list || []).map((item) => el('span', { class: 'pill', text: item })))
// Every copy button says WHAT it copies: a screen reader lists buttons out of
// context, and four of them named just "Копировать" cannot be told apart.
const command = (text, purpose = 'команду') =>
  el('div', { class: 'cmd' }, el('code', { text }), el('button', { type: 'button', 'aria-label': `Копировать ${purpose}`, onclick: () => copy(text), text: 'Копировать' }))

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

// ── screens ───────────────────────────────────────────────────────────────
async function overview() {
  const data = await api('/api/overview')
  if (!data.initialized) return page('Обзор', 'Журнал не найден', uninitialised(data.hint))
  const s = data.status
  // status() counts every pending approval; an expired one can no longer be
  // granted, so it is shown apart instead of inflating "waiting for you".
  const waitingNow = await api('/api/waiting').catch(() => null)
  const known = Boolean(waitingNow) // if it failed the split is unknown; say so, do not guess zero
  const expired = (waitingNow?.approvals || []).filter((a) => a.expired).length
  // Both numbers from one snapshot: status() and /api/waiting are read at different moments.
  const live = known ? (waitingNow.approvals || []).length - expired : s.approvals_pending
  // A tile that has a screen behind it is a link to it: the numbers the owner
  // must act on (approvals, decisions) should not need a second hunt in the menu.
  const tile = (n, label, hot, href) =>
    el(href ? 'a' : 'div', { class: `tile${hot ? ' hot' : ''}${href ? ' link' : ''}`, href }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: label }))
  const problems = data.doctor?.problems || []
  return page(
    'Обзор',
    s.journal_root || data.journal_root,
    el('div', { class: 'grid' },
      tile(s.tasks.open, 'открытых задач', false, '#/tasks'),
      known
        ? tile(live, expired ? `ждут вашего одобрения (ещё ${expired} просрочено)` : 'ждут вашего одобрения', live > 0, '#/waiting')
        : tile(s.approvals_pending, 'ждут одобрения (часть может быть просрочена: не удалось проверить)', s.approvals_pending > 0, '#/waiting'),
      tile(s.decisions_open, 'открытых решений', s.decisions_open > 0, '#/waiting'),
      tile(s.reviews_pending, 'ревью в очереди', false, '#/waiting'),
      tile(s.runs_failed, 'проверок упало', s.runs_failed > 0)),
    el('h2', { text: 'Агенты' }),
    el('div', { class: 'list' }, s.agents.map((a) =>
      el('div', { class: 'row' }, pill(a.status), el('strong', { text: a.id }), el('span', { class: 'grow muted', text: a.adapter?.how || '' }),
        a.current_task_id ? el('a', { href: `#/tasks/${encodeURIComponent(a.current_task_id)}`, class: 'mono', text: a.current_task_id }) : null))),
    el('h2', { text: 'Задачи по статусам' }),
    Object.keys(s.tasks.by_status).length
      ? el('div', { class: 'chips' }, Object.entries(s.tasks.by_status).map(([k, v]) => el('span', { class: `pill ${STATUS_TONE[k] || ''}`, title: k, text: `${statusText(k)}  ${v}` })))
      : empty('Задач пока нет'),
    s.delegations?.length
      ? [el('h2', { text: 'Делегирование (заявлено ведущим, не проверено)' }),
         el('div', { class: 'list' }, s.delegations.map((d) =>
           el('div', { class: 'row' }, el('span', { class: 'mono', text: `${d.by} → ${d.to}` }), el('span', { class: 'pill', text: `${d.model}${d.level ? ` · ${d.level}` : ''}` }),
             el('span', { class: 'grow', text: d.purpose || d.task_title || '' }))))]
      : null,
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
  const url = new URL(location.href)
  const all = url.hash.includes('all=1')
  // "All" means no filter at all: open=0 would mean "closed only", the opposite
  // of what the link promises.
  const list = await api(all ? '/api/tasks' : '/api/tasks?open=1')
  const toggle = el('a', { href: all ? '#/tasks' : '#/tasks?all=1', text: all ? 'Только открытые' : 'Показать все, включая закрытые' })
  // A long list is searched, not scrolled: id, title, owner and the status word
  // (raw or Russian) are all matched.
  const rows = list.map((t) => ({
    text: `${t.id} ${t.title} ${t.owner || ''} ${t.status} ${statusText(t.status)} ${t.standstill ? `${STANDSTILL_RU[t.standstill.code] || ''} ${t.standstill.detail}` : ''}`.toLowerCase(),
    node: el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(t.id)}` }, pill(t.status),
      el('span', { class: 'grow' }, t.title,
        t.standstill ? el('div', { class: 'muted small' }, standstillPill(t.standstill), ` ${t.standstill.detail}`) : null),
      el('span', { class: 'mono muted', text: t.owner || 'без исполнителя' }))
  }))
  const none = el('div', { class: 'empty', text: 'Ничего не найдено', hidden: true })
  const count = el('span', { class: 'muted small', text: `${list.length}` })
  const search = el('input', { type: 'search', placeholder: 'Поиск: номер, название, исполнитель, статус', 'aria-label': 'Поиск по задачам', oninput: (e) => {
    const query = e.target.value.trim().toLowerCase()
    let shown = 0
    for (const row of rows) {
      row.node.hidden = Boolean(query) && !row.text.includes(query)
      if (!row.node.hidden) shown += 1
    }
    none.hidden = shown > 0
    count.textContent = query ? `${shown} из ${list.length}` : `${list.length}`
  } })
  return page('Задачи', all ? 'Все задачи' : 'Открытые задачи', el('div', { class: 'toolbar' }, search, count, toggle),
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
    t.completion_summary ? [el('h2', { text: 'Итог' }), el('div', { class: 'detail', text: plain(t.completion_summary) })] : null,
    t.description ? el('div', { class: 'card', text: t.description }) : null,
    t.spec?.acceptance_criteria?.length ? [el('h2', { text: 'Критерии приёмки' }), el('div', { class: 'card' }, t.spec.acceptance_criteria.map((c) => el('div', { text: `• ${c}` })))] : null,
    // The verdict alone is not the review: what the reviewer found is the point.
    [el('h2', { text: 'Ревью' }), data.reviews?.length ? data.reviews.map(reviewCard) : empty('—')],
    section('Делегирование', data.delegations || t.delegations, (d) => el('div', { class: 'row' }, el('span', { class: 'mono', text: `${d.by || ''} → ${d.to || ''}` }), el('span', { class: 'pill', text: d.model || '' }), el('span', { class: 'grow', text: d.purpose || '' }), pill(d.outcome || 'идёт'))),
    section('Прогоны проверок', t.runs, (r) => el('div', { class: 'row' }, pill(r.status), el('span', { class: 'mono', text: r.runner }), el('span', { class: 'grow', text: r.headline || '' }))),
    section('Сообщения', data.messages, (m) => el('div', { class: 'row msg' },
      el('span', { class: 'mono muted', text: `${m.from_agent || '?'} · ${when(m.created_at)}` }),
      el('span', { class: 'grow' }, m.subject ? el('strong', { text: m.subject }) : null, m.subject ? el('br') : null, el('span', { class: 'body', text: m.body || '' })))),
    t.files?.length ? [el('h2', { text: 'Файлы задачи' }), el('div', { class: 'card mono', text: t.files.join('\n') })] : null)
}

const labelled = (label, text, purpose) => el('div', {}, el('div', { class: 'cmd-label', text: label }), command(text, purpose))
const plain = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))

function reviewCard(r) {
  const findings = r.findings || []
  return el('div', { class: 'card' },
    el('div', {}, pill(r.verdict || 'pending'), ' ', el('span', { class: 'mono', text: `${r.slot || r.requested_role || ''}${r.round ? ` · раунд ${r.round}` : ''}` }),
      r.reviewer ? el('span', { class: 'muted', text: ` · ${r.reviewer}` }) : null,
      r.independence === 'same_agent_separate_session' ? el('span', { class: 'pill warn', text: 'та же модельная семья' }) : null),
    r.summary ? el('div', { class: 'detail', text: plain(r.summary) }) : null,
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
    r.length ? el('div', { class: 'list' }, r.map((x) => el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(x.task_id)}` }, pill('pending'), el('span', { class: 'grow', text: x.slot || x.reviewer_role || x.id }), el('span', { class: 'mono muted', text: x.task_id })))) : empty('Очередь пуста'))
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
  let follow = true
  let filter = ''
  const rows = []
  // Recomputed on every change — a filter typed earlier and an event arriving later both move it.
  const updateNoMatch = () => {
    noMatch.hidden = !filter || rows.length === 0 || rows.some((row) => !row.node.hidden)
  }
  const render = (event) => {
    const node = el('details', { class: 'ev' },
      el('summary', {}, el('span', { class: 't', text: when(event.ts) }), el('span', { class: 'ty', text: event.type }), el('span', { text: `${event.actor || ''} ${event.subject?.id || ''}` })),
      el('pre', { text: JSON.stringify(event.data ?? {}, null, 2) }))
    rows.push({ node, text: `${event.type} ${event.actor} ${event.subject?.id} ${JSON.stringify(event.data ?? {})}`.toLowerCase() })
    node.hidden = Boolean(filter) && !rows[rows.length - 1].text.includes(filter)
    box.append(node)
    emptyNote.hidden = true
    updateNoMatch()
    if (follow) box.scrollTop = box.scrollHeight
  }
  initial.forEach(render)
  const search = el('input', { type: 'search', placeholder: 'Фильтр', 'aria-label': 'Фильтр событий', oninput: (e) => {
    filter = e.target.value.trim().toLowerCase()
    for (const row of rows) row.node.hidden = Boolean(filter) && !row.text.includes(filter)
    updateNoMatch()
  } })
  const followBtn = el('button', { type: 'button', 'aria-pressed': 'true', text: 'Автопрокрутка: вкл', onclick: () => {
    follow = !follow
    followBtn.setAttribute('aria-pressed', String(follow))
    followBtn.textContent = `Автопрокрутка: ${follow ? 'вкл' : 'выкл'}`
  } })
  closeStream()
  stream = new EventSource(`/api/stream?t=${encodeURIComponent(PANEL_TOKEN)}`) // EventSource cannot send headers
  stream.onmessage = (message) => {
    try { render(JSON.parse(message.data)) } catch { /* a malformed line is skipped, the stream goes on */ }
  }
  stream.onopen = () => setConn('ok', 'подключено')
  stream.onerror = () => setConn('warn', 'переподключение…')
  return page('Лента', 'События журнала в реальном времени', el('div', { class: 'toolbar' }, search, followBtn), emptyNote, noMatch, box)
}

async function roster() {
  const data = await api('/api/roster')
  return page('Состав', `Ведущий: ${data.lead || 'не назначен'} · ${REVIEW_MODE_RU[data.review_mode] || data.review_mode || 'режим ревью не задан'}`,
    data.lead ? null : el('div', { class: 'note warn' }, 'Состав на этой машине не настроен, действуют встроенные настройки. ', el('a', { href: '#/setup', text: 'Открыть мастер настройки' })),
    el('h2', { text: 'Агенты' }),
    el('table', {}, el('thead', {}, el('tr', {}, ['Агент', 'Провайдер', 'Роли', 'Статус'].map((h) => el('th', { text: h })))),
      el('tbody', {}, data.agents.map((a) => el('tr', {}, el('td', {}, el('strong', { text: a.id }), a.id === data.lead ? ' (ведущий)' : ''), el('td', { text: a.provider || '' }), el('td', {}, chips(a.roles)), el('td', {}, pill(a.status)))))),
    el('h2', { text: 'Роли' }),
    el('table', {}, el('tbody', {}, Object.entries(data.roles || {}).map(([name, r]) => el('tr', {}, el('td', { class: 'mono', text: name }), el('td', { text: r.summary || '' }))))),
    el('h2', { text: 'Уровни и модели' }),
    modelsTable(data.models))
}

function modelsTable(models) {
  const levels = models?.levels || models || []
  const list = Array.isArray(levels) ? levels : Object.entries(levels).map(([level, v]) => ({ level, ...v }))
  if (!list.length) return empty('Нет данных о моделях')
  return el('div', { class: 'list' }, list.map((l) =>
    el('div', { class: 'row' }, el('strong', { text: l.level || l.id || '' }), el('span', { class: 'grow', text: l.summary || l.meaning || '' }),
      chips((l.models || l.rungs || []).map((m) => (typeof m === 'string' ? m : m.ref || m.id || m.model || JSON.stringify(m)))))))
}

async function kit() {
  const data = await api('/api/kit')
  let tab = 'skills'
  let query = ''
  const holder = el('div', {})
  const labels = { skills: 'Скиллы', agents: 'Агенты', rules: 'Правила' }
  const draw = () => {
    holder.replaceChildren()
    const items = (data[tab] || []).filter((x) => `${x.name} ${x.description || ''}`.toLowerCase().includes(query))
    holder.append(items.length ? el('div', { class: 'list' }, items.map((x) =>
      el('div', { class: 'row' }, el('strong', { class: 'mono', text: x.name }), el('span', { class: 'grow', text: x.description || (x.problem ? `проблема: ${x.problem}` : '') }),
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
  return page('Скиллы и агенты', 'Читается из файлов набора: список нигде не ведётся вручную.', el('div', { class: 'toolbar' }, tabs, search), holder)
}

// ── setup wizard ──────────────────────────────────────────────────────────
async function setup() {
  const detect = await api('/api/setup/detect')
  const chosen = new Set(detect.installed)
  let lead = detect.installed[0] || null
  let forceSingle = false
  let lastPlan = null // the composition the user has chosen right now, for the check
  const out = el('div', {})
  const reviewNote = el('div', { class: 'note' })
  const checkOut = el('div', {})

  let previewSeq = 0
  const drawPreview = async () => {
    // Clicks can outrun the server: only the answer to the LATEST selection may
    // be drawn, or two command sets and a wrong lastPlan would stay on screen.
    const seq = ++previewSeq
    out.replaceChildren()
    lastPlan = null
    reviewNote.textContent = ''
    if (!chosen.size) return out.append(el('div', { class: 'note warn', text: 'Отметьте хотя бы одного агента.' }))
    if (!lead || !chosen.has(lead)) lead = [...chosen][0]
    const query = new URLSearchParams({ agents: [...chosen].join(','), lead, single_vendor: forceSingle ? '1' : '0' })
    let preview
    try { preview = await api(`/api/setup/preview?${query}`) } catch (error) { return seq === previewSeq ? out.append(el('div', { class: 'note bad', text: error.message })) : undefined }
    if (seq !== previewSeq) return
    if (!preview.ok) return out.append(el('div', { class: 'note bad', text: preview.reason }))
    lastPlan = preview.plan
    const missing = [...chosen].filter((id) => !detect.installed.includes(id))
    if (missing.length) {
      out.append(el('div', { class: 'note warn', text: `Не найдено на этой машине: ${missing.join(', ')}. Команда запишет такого агента в состав, но пользоваться им можно будет только после установки его программы.` }))
    }
    reviewNote.textContent = preview.plan.review_mode === 'single_vendor'
      ? 'Одна модельная семья: ревью делает тот же агент в отдельной сессии. Независимость ниже, это записывается в каждое ревью.'
      : 'Разные модельные семьи: ревью никогда не достаётся автору.'
    out.append(
      el('h2', { id: 'step-4', text: '4. Роли (задаются реестром, здесь только справка)' }),
      el('div', { class: 'list' }, preview.plan.agents.map((a) => el('div', { class: 'row' }, el('strong', { text: a.id }), a.id === lead ? el('span', { class: 'pill', text: 'ведущий' }) : null, el('span', { class: 'grow' }, chips(a.roles))))),
      el('h2', { id: 'step-5', text: '5. Проект' }),
      projectCard(detect.project),
      el('h2', { id: 'step-6', text: '6. Команды для терминала' }),
      el('p', { class: 'sub', text: 'Панель ничего не записывает: права агентам выдаёт только владелец в своём терминале (в этой сессии — через приставку «!»).' }),
      ...preview.commands.map((c) => el('div', {}, el('div', { class: 'muted', text: c.title }), command(c.command), c.note ? el('div', { class: 'muted', text: c.note }) : null)),
      el('div', { class: 'toolbar' }, el('button', { type: 'button', class: 'primary', text: 'Проверить, что получилось', onclick: runCheck })))
  }

  // Two separate answers, so that "nothing is broken" is never read as "your
  // choice is applied": first what is recorded on this machine against what was
  // chosen above, then the general health of the kit.
  const compareBlock = (machine) => {
    if (!lastPlan) return [el('div', { class: 'note warn', text: 'Выбор выше неполный, сравнивать не с чем.' })]
    if (!machine) return [el('div', { class: 'note warn', text: 'Не применено: на этой машине состав ещё не записан. Выполните команду из шага 6 в терминале и нажмите «Проверить» снова.' })]
    if (machine.problem) return [el('div', { class: 'note bad', text: `Файл состава на машине не читается: ${machine.problem}` })]
    const want = new Set(lastPlan.agents.map((a) => a.id))
    const have = new Set(machine.agents.map((a) => a.id))
    const mismatches = []
    if (machine.lead !== lastPlan.lead) mismatches.push(`ведущий: записан ${machine.lead || 'никто'}, выбран ${lastPlan.lead}`)
    if (machine.review_mode !== lastPlan.review_mode) mismatches.push(`режим ревью: записан «${REVIEW_MODE_RU[machine.review_mode] || machine.review_mode || '—'}», выбран «${REVIEW_MODE_RU[lastPlan.review_mode] || lastPlan.review_mode}»`)
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
    checkOut.replaceChildren(el('div', { class: 'muted', text: 'Проверяю…' }))
    try {
      const [now, doc] = await Promise.all([api('/api/setup/detect'), api('/api/setup/check')])
      const problems = [...(doc.unheld_roles || []).map((r) => `Роль без исполнителя: ${r}`), ...(doc.agents || []).filter((a) => a.available === false || a.ok === false).map((a) => `Агент ${a.id}: ${a.reason || a.how || 'недоступен'}`)]
      checkOut.replaceChildren(
        el('h3', { text: 'Записан ли выбранный состав' }), ...compareBlock(now.current?.machine),
        el('h3', { text: 'Общее состояние набора (не зависит от выбора выше)' }),
        ...(problems.length ? problems.map((p) => el('div', { class: 'note warn', text: p })) : [el('div', { class: 'note', text: 'Проблем не найдено.' })]),
        el('div', { class: 'list' }, (doc.agents || []).map((a) => el('div', { class: 'row' }, el('strong', { text: a.id }), el('span', { class: 'grow muted', text: a.how || a.detail || '' })))))
    } catch (error) {
      checkOut.replaceChildren(el('div', { class: 'note bad', text: error.message }))
    }
  }

  const agentsBox = el('div', { class: 'list' }, detect.catalog.map((a) => {
    const installed = detect.installed.includes(a.id)
    const box = el('input', { type: 'checkbox', id: `ag-${a.id}`, checked: installed, onchange: (e) => {
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
  const single = el('label', { class: 'choice' }, el('input', { type: 'checkbox', onchange: (e) => { forceSingle = e.target.checked; drawPreview() } }), el('span', { text: 'Принудительно считать одной модельной семьёй (--single-vendor)' }))
  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'auto', block: 'start' })
  drawLead(); drawPreview()
  return page('Мастер настройки', 'Соберите состав коллаборации и получите готовые команды. Пока вы не выполнили команду в терминале, на машине ничего не меняется.',
    // A plain table of contents: it jumps to a step, it does not claim progress.
    el('nav', { class: 'steps', 'aria-label': 'Шаги мастера' }, ['Кто участвует', 'Ведущий', 'Режим ревью', 'Роли', 'Проект', 'Команды'].map((s, i) =>
      el('button', { type: 'button', class: 'chip', onclick: () => jump(`step-${i + 1}`), text: `${i + 1}. ${s}` }))),
    el('h2', { id: 'step-1', text: '1. Кто участвует' }), agentsBox,
    el('h2', { id: 'step-2', text: '2. Кто ведущий' }), el('p', { class: 'sub', text: 'Ведущий — агент, в котором вы сами работаете; он распределяет работу, остальные берут задачи через журнал.' }), leadBox,
    el('h2', { id: 'step-3', text: '3. Режим ревью' }), reviewNote, single,
    out, el('h2', { text: 'Проверка' }), checkOut)
}

function projectCard(p) {
  if (!p) return empty('Нет данных о проекте')
  const connected = Boolean(p.projectId)
  return el('div', { class: 'card' },
    el('div', { class: 'mono', text: p.journalRoot || p.cwd || '' }),
    el('div', { class: 'chips' }, el('span', { class: `pill ${p.initialized ? 'ok' : 'warn'}`, text: p.initialized ? 'журнал есть' : 'журнала нет' }), el('span', { class: `pill ${connected ? 'ok' : 'warn'}`, text: connected ? `подключён как ${p.projectId}` : 'не подключён к набору' })),
    connected ? null : [el('p', { class: 'sub', text: 'Посмотреть, что запишет подключение (ничего не пишет):' }), command('collab connect --dry-run', 'команду просмотра подключения'), el('div', { class: 'muted', text: 'Применить подключение — команда collab connect без --dry-run, в терминале проекта.' })])
}

// ── routing ───────────────────────────────────────────────────────────────
const ROUTES = { overview, tasks, waiting, events, roster, kit, setup }

function closeStream() {
  if (stream) { stream.close(); stream = null }
}
function setConn(tone, text) {
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

const TITLES = { overview: 'Обзор', tasks: 'Задачи', waiting: 'Ждёт вас', events: 'Лента', roster: 'Состав', kit: 'Скиллы и агенты', setup: 'Мастер настройки' }

async function route() {
  const seq = ++routeSeq
  closeStream()
  setConn('', 'панель только для чтения')
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
  document.title = `${TITLES[name] || TITLES.overview} · Agent Kit`
  main.focus({ preventScroll: true })
  refreshBadge()
}

// The token is kept out of the address bar (history) once read; see PANEL_TOKEN.
if (location.search.includes('t=')) history.replaceState(null, '', location.pathname + location.hash)
window.addEventListener('hashchange', route)
route()
