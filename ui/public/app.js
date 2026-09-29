// Agent Kit panel: read-only views over the collab journal and the kit files.
// Everything the journal contains was written by agents, so it is untrusted:
// every value goes into the page through textContent, never as markup.
'use strict'

const main = document.getElementById('main')
const toastBox = document.getElementById('toast')
let stream = null
let toastTimer = null

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

async function api(path) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
const pill = (status) => el('span', { class: `pill ${STATUS_TONE[status] || ''}`, text: status ?? '—' })
const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—')
const chips = (list) => el('div', { class: 'chips' }, (list || []).map((item) => el('span', { class: 'pill', text: item })))
const command = (text) =>
  el('div', { class: 'cmd' }, el('code', { text }), el('button', { type: 'button', onclick: () => copy(text), text: 'Копировать' }))

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
  const expired = (waitingNow?.approvals || []).filter((a) => a.expired).length
  const live = s.approvals_pending - expired
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
      tile(live, expired ? `ждут вашего одобрения (ещё ${expired} просрочено)` : 'ждут вашего одобрения', live > 0, '#/waiting'),
      tile(s.decisions_open, 'открытых решений', s.decisions_open > 0, '#/waiting'),
      tile(s.reviews_pending, 'ревью в очереди', false, '#/waiting'),
      tile(s.runs_failed, 'проверок упало', s.runs_failed > 0)),
    el('h2', { text: 'Агенты' }),
    el('div', { class: 'list' }, s.agents.map((a) =>
      el('div', { class: 'row' }, pill(a.status), el('strong', { text: a.id }), el('span', { class: 'grow muted', text: a.adapter?.how || '' }),
        a.current_task_id ? el('a', { href: `#/tasks/${encodeURIComponent(a.current_task_id)}`, class: 'mono', text: a.current_task_id }) : null))),
    el('h2', { text: 'Задачи по статусам' }),
    Object.keys(s.tasks.by_status).length
      ? el('div', { class: 'chips' }, Object.entries(s.tasks.by_status).map(([k, v]) => el('span', { class: `pill ${STATUS_TONE[k] || ''}`, text: `${k}  ${v}` })))
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
  return page('Задачи', all ? `Все задачи: ${list.length}` : `Открытые задачи: ${list.length}`, el('div', { class: 'toolbar' }, toggle),
    list.length
      ? el('div', { class: 'list' }, list.map((t) =>
          el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(t.id)}` }, pill(t.status), el('span', { class: 'grow', text: t.title }), el('span', { class: 'mono muted', text: t.owner || 'без исполнителя' }))))
      : empty('Задач нет'))
}

async function taskDetail(id) {
  const data = await api(`/api/tasks/${encodeURIComponent(id)}`)
  const t = data.task
  const section = (title, items, render) => [el('h2', { text: title }), items?.length ? el('div', { class: 'list' }, items.map(render)) : empty('—')]
  return page(t.title, `${t.id} · ${t.owner || 'без исполнителя'} · ${t.role || 'роль не указана'}`,
    el('div', { class: 'toolbar' }, pill(t.status), el('a', { href: '#/tasks', text: '← ко всем задачам' })),
    t.description ? el('div', { class: 'card', text: t.description }) : null,
    t.spec?.acceptance_criteria?.length ? [el('h2', { text: 'Критерии приёмки' }), el('div', { class: 'card' }, t.spec.acceptance_criteria.map((c) => el('div', { text: `• ${c}` })))] : null,
    section('Ревью', data.reviews, (r) => el('div', { class: 'row' }, pill(r.verdict || 'pending'), el('span', { class: 'mono', text: r.slot || r.reviewer_role || '' }), el('span', { class: 'grow muted', text: r.reviewer_role || '' }))),
    section('Делегирование', data.delegations || t.delegations, (d) => el('div', { class: 'row' }, el('span', { class: 'mono', text: `${d.by || ''} → ${d.to || ''}` }), el('span', { class: 'pill', text: d.model || '' }), el('span', { class: 'grow', text: d.purpose || '' }), pill(d.outcome || 'идёт'))),
    section('Прогоны проверок', t.runs, (r) => el('div', { class: 'row' }, pill(r.status), el('span', { class: 'mono', text: r.runner }), el('span', { class: 'grow', text: r.headline || '' }))),
    section('Сообщения', data.messages, (m) => el('div', { class: 'row msg' },
      el('span', { class: 'mono muted', text: `${m.from_agent || '?'} · ${when(m.created_at)}` }),
      el('span', { class: 'grow' }, m.subject ? el('strong', { text: m.subject }) : null, m.subject ? el('br') : null, el('span', { class: 'body', text: m.body || '' })))),
    t.files?.length ? [el('h2', { text: 'Файлы задачи' }), el('div', { class: 'card mono', text: t.files.join('\n') })] : null)
}

const labelled = (label, text) => el('div', {}, el('div', { class: 'cmd-label', text: label }), command(text))
const plain = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))

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
    el('div', { class: 'mono muted', text: `запросил ${x.requested_by || '?'}${x.task_id ? ` · задача ${x.task_id}` : ''}` }),
    labelled('Одобрить (в терминале)', `collab approve ${x.id}`),
    labelled('Отклонить (в терминале, причина обязательна)', `collab reject ${x.id} --note "причина"`))
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
      labelled('Выбрать (в терминале)', `collab decide ${x.id} ${o.id}`))),
    (x.positions || []).length ? el('h3', { text: 'Позиции агентов' }) : null,
    ...(x.positions || []).map((p) => el('div', { class: 'position' },
      el('span', { class: 'mono', text: `${p.agent || '?'} → ${label.get(p.option) || p.option || '—'}` }),
      p.rationale ? el('div', { class: 'muted', text: p.rationale }) : null)))
}

async function waiting() {
  const data = await api('/api/waiting')
  const a = data.approvals || []
  const d = data.decisions || []
  const r = data.reviews || []
  return page('Ждёт вас', 'Одобрения и решения выдаются только в терминале: панель их показывает, но не выдаёт.',
    el('h2', { text: `Одобрения (${a.length})` }),
    a.length ? a.map(approvalCard) : empty('Нет ожидающих одобрений'),
    el('h2', { text: `Решения (${d.length})` }),
    d.length ? d.map(decisionCard) : empty('Нет открытых споров'),
    el('h2', { text: `Ревью в очереди (${r.length})` }),
    r.length ? el('div', { class: 'list' }, r.map((x) => el('a', { class: 'row', href: `#/tasks/${encodeURIComponent(x.task_id)}` }, pill('pending'), el('span', { class: 'grow', text: x.slot || x.reviewer_role || x.id }), el('span', { class: 'mono muted', text: x.task_id })))) : empty('Очередь пуста'))
}

async function events() {
  const initial = await api('/api/events?limit=100')
  const box = el('div', { class: 'log', id: 'log', tabindex: '0', role: 'log', 'aria-label': 'Лента событий' })
  let follow = true
  let filter = ''
  const rows = []
  const render = (event) => {
    const node = el('details', { class: 'ev' },
      el('summary', {}, el('span', { class: 't', text: when(event.ts) }), el('span', { class: 'ty', text: event.type }), el('span', { text: `${event.actor || ''} ${event.subject?.id || ''}` })),
      el('pre', { text: JSON.stringify(event.data ?? {}, null, 2) }))
    rows.push({ node, text: `${event.type} ${event.actor} ${event.subject?.id} ${JSON.stringify(event.data ?? {})}`.toLowerCase() })
    node.hidden = filter && !rows[rows.length - 1].text.includes(filter)
    box.append(node)
    if (follow) box.scrollTop = box.scrollHeight
  }
  initial.forEach(render)
  const search = el('input', { type: 'search', placeholder: 'Фильтр', 'aria-label': 'Фильтр событий', oninput: (e) => {
    filter = e.target.value.trim().toLowerCase()
    for (const row of rows) row.node.hidden = Boolean(filter) && !row.text.includes(filter)
  } })
  const followBtn = el('button', { type: 'button', 'aria-pressed': 'true', text: 'Автопрокрутка: вкл', onclick: () => {
    follow = !follow
    followBtn.setAttribute('aria-pressed', String(follow))
    followBtn.textContent = `Автопрокрутка: ${follow ? 'вкл' : 'выкл'}`
  } })
  closeStream()
  stream = new EventSource('/api/stream')
  stream.onmessage = (message) => {
    try { render(JSON.parse(message.data)) } catch { /* a malformed line is skipped, the stream goes on */ }
  }
  stream.onopen = () => setConn('ok', 'подключено')
  stream.onerror = () => setConn('warn', 'переподключение…')
  return page('Лента', 'События журнала в реальном времени', el('div', { class: 'toolbar' }, search, followBtn), box)
}

async function roster() {
  const data = await api('/api/roster')
  return page('Состав', `Ведущий: ${data.lead || 'не назначен'} · режим ревью: ${data.review_mode || '—'}`,
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

  const drawPreview = async () => {
    out.replaceChildren()
    lastPlan = null
    reviewNote.textContent = ''
    if (!chosen.size) return out.append(el('div', { class: 'note warn', text: 'Отметьте хотя бы одного агента.' }))
    if (!lead || !chosen.has(lead)) lead = [...chosen][0]
    const query = new URLSearchParams({ agents: [...chosen].join(','), lead, single_vendor: forceSingle ? '1' : '0' })
    let preview
    try { preview = await api(`/api/setup/preview?${query}`) } catch (error) { return out.append(el('div', { class: 'note bad', text: error.message })) }
    if (!preview.ok) return out.append(el('div', { class: 'note bad', text: preview.reason }))
    lastPlan = preview.plan
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
    if (machine.review_mode !== lastPlan.review_mode) mismatches.push(`режим ревью: записан ${machine.review_mode || '—'}, выбран ${lastPlan.review_mode}`)
    const missing = [...want].filter((id) => !have.has(id))
    const extra = [...have].filter((id) => !want.has(id))
    if (missing.length) mismatches.push(`нет на машине: ${missing.join(', ')}`)
    if (extra.length) mismatches.push(`записано лишнее: ${extra.join(', ')}`)
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
    connected ? null : [el('p', { class: 'sub', text: 'Посмотреть, что запишет подключение (ничего не пишет):' }), command('collab connect --dry-run'), el('div', { class: 'muted', text: 'Применить подключение — `collab connect` в терминале проекта.' })])
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

async function refreshBadge() {
  try {
    const w = await api('/api/waiting')
    // An expired approval cannot be granted any more; it is not "waiting for you".
    const n = (w.approvals || []).filter((a) => !a.expired).length + (w.decisions?.length || 0)
    const badge = document.getElementById('waiting-count')
    badge.textContent = String(n)
    badge.hidden = n === 0
  } catch { /* the badge is a convenience; the screens report real errors */ }
}

async function route() {
  closeStream()
  setConn('', 'панель только для чтения')
  const [name = 'overview', ...rest] = location.hash.replace(/^#\//, '').split('?')[0].split('/')
  const screen = ROUTES[name] || overview
  for (const link of document.querySelectorAll('[data-route]')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current')
  }
  main.replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }))
  try {
    const nodes = await screen(rest.length ? decodeURIComponent(rest.join('/')) : undefined)
    main.replaceChildren(...[nodes].flat(3).filter(Boolean))
  } catch (error) {
    main.replaceChildren(...failure(error))
  }
  main.focus({ preventScroll: true })
  refreshBadge()
}

// The first visit carries ?t=<token>; the server turns it into a cookie, and the
// token is then removed from the address bar so it is not left in history.
if (location.search.includes('t=')) history.replaceState(null, '', location.pathname + location.hash)
window.addEventListener('hashchange', route)
route()
