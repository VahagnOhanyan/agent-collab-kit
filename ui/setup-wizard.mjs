import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { describeProject } from '../collab/src/api.mjs'
import { detectBinary, planComposition, rolesItCanHold, writeComposition } from '../collab/src/composition.mjs'
import { independenceReport } from '../collab/src/independence.mjs'
import { DEFAULT_CONFIG_DIR } from '../collab/src/paths.mjs'
import { loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../collab/src/registry.mjs'

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

function executableOnPath(binary) {
  if (!binary) return null
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, process.platform === 'win32' && !binary.toLowerCase().endsWith(extension.toLowerCase()) ? `${binary}${extension}` : binary)
      try {
        const stat = statSync(candidate)
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate
      } catch {
        // Detection is advisory; an unreadable PATH entry simply is not installed.
      }
    }
  }
  return null
}

const fingerprint = (bytes) => createHash('sha256').update(bytes).digest('hex')

function machineComposition(machineDir) {
  const file = machineDir ? join(machineDir, 'agents.json') : null
  if (!file || !existsSync(file)) return null
  try {
    const content = JSON.parse(readFileSync(file, 'utf8'))
    return {
      lead: content.lead || null,
      review_mode: content.review_mode || null,
      agents: (content.agents || []).map((agent) => ({ id: agent.id, roles: agent.roles || [] })),
      expect: fingerprint(readFileSync(file))
    }
  } catch (error) {
    return { problem: error.message }
  }
}

// The roles as the registry will read them after a write: the machine's own roles.json when it has one, the
// catalog otherwise. Every check here uses the same definitions the written file is validated and run with.
function machineRoleDefs(machineDir) {
  return loadConfigFrom(machineDir ? [machineDir] : null, machineDir ? { kind: 'machine', dir: machineDir } : { kind: 'built-in' }).roles.roles
}

export function detectSetup({ registryDir, machineDir, cwd }) {
  const catalog = loadBuiltinAgents()
  // A broken roles.json on the machine is named, never a crash of the page that should show it.
  let roles
  let rolesProblem = null
  try {
    roles = machineRoleDefs(machineDir)
  } catch (error) {
    roles = loadConfigFrom().roles.roles
    rolesProblem = error.message
  }
  const project = describeProject({ cwd, registryDir })
  return {
    catalog: (catalog.agents || []).map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider, roles: agent.roles || [] })),
    installed: (catalog.agents || []).filter((agent) => executableOnPath(detectBinary(agent))).map((agent) => agent.id),
    roles,
    roles_problem: rolesProblem,
    current: { machine: machineComposition(machineDir), project: project.projectId },
    project
  }
}

function command(tokens) {
  return tokens.join(' ')
}

export function previewSetup({ agents, lead, singleVendor, roles = null, registryDir, machineDir, cwd }) {
  if (!Array.isArray(agents) || !agents.length) return { ok: false, reason: 'choose at least one agent' }
  if (!agents.every((id) => ID.test(id)) || !ID.test(lead || '')) return { ok: false, reason: 'agent ids must use lowercase letters, digits, _ or -' }
  if (singleVendor !== '0' && singleVendor !== '1') return { ok: false, reason: 'single_vendor must be 0 or 1' }

  const catalog = loadBuiltinAgents()
  let roleDefs
  try {
    roleDefs = machineRoleDefs(machineDir)
  } catch (error) {
    return { ok: false, reason: `Настройки ролей на машине не читаются: ${error.message}` }
  }
  const planned = planComposition({ catalog, roleDefs, include: agents, lead, singleVendor: singleVendor === '1' })
  if (!planned.ok) return planned

  const project = describeProject({ cwd, registryDir })
  const setupTokens = ['collab', 'setup', '--agents', agents.join(','), '--lead', lead]
  if (singleVendor === '1') setupTokens.push('--single-vendor')
  // The panel speaks Russian, so the labels the screen shows are Russian; the
  // commands themselves are what the terminal understands and stay as they are.
  const commands = [{ title: 'Настроить состав на этой машине', command: command(setupTokens), note: 'Запустите в своём терминале: он спросит подтверждение.' }]
  if (!project.projectId) {
    commands.push({ title: 'Подключить этот проект', command: 'collab connect --dry-run', note: 'Сначала посмотрите, куда исполнителям будет разрешено писать, и только потом запускайте без --dry-run.' })
  }
  return {
    ok: true,
    plan: {
      lead: planned.content.lead,
      review_mode: planned.content.review_mode,
      agents: planned.content.agents.map((agent) => ({ id: agent.id, roles: agent.roles || [] }))
    },
    commands,
    apply: publicApply(evaluateApply({ agents, lead, singleVendor: singleVendor === '1', roles, machineDir }))
  }
}

// ── applying the lead and the review mode from the panel ─────────────────────
//
// What the panel writes into the composition that already sits on this machine:
// `lead`, `review_mode` and the roles of each agent (ADR-0025, ADR-0026). Which
// agents are in it stays `collab setup` at the owner's terminal. The file is
// parsed, those fields are set on the parsed object and every other key
// (agents' other fields, defaults, notes) is written back as it was, in order.

const compositionFile = (machineDir) => join(machineDir, 'agents.json')
const previousFile = (machineDir) => join(machineDir, 'agents.json.prev')
// The fingerprint of what the panel last wrote. "Вернуть прежний" is offered only while the composition is still
// exactly that: once the owner changed it anywhere else (`collab setup`, by hand), going back would undo their change.
const writtenMarkFile = (machineDir) => join(machineDir, 'agents.json.prev.after')

function writeAtomically(file, bytes) {
  const staged = `${file}.tmp-${process.pid}`
  writeFileSync(staged, bytes)
  renameSync(staged, file)
}

function registryProblems(machineDir) {
  return validateRegistry(loadConfigFrom([machineDir], { kind: 'machine', dir: machineDir })).problems
}

// ── roles chosen in the panel ────────────────────────────────────────────────
//
// The owner may tick which roles each agent holds. Three things are refused, whatever the page sent: a role the
// catalog does not declare, a role whose required capabilities the agent does not have, and a composition that
// leaves some kind of work nobody but its author to review while two vendors are there (independence.mjs).

const rolesEqual = (a = [], b = []) => [...a].sort().join(',') === [...b].sort().join(',')

// `roles` is { agentId: [role, …] } for exactly the agents in play, or null (keep what is there).
function settleRoles({ agents, roles, roleDefs }) {
  if (roles === null || roles === undefined) return { ok: true, agents }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { ok: false, reason: 'Роли переданы в неверном виде.' }
  const ids = agents.map((agent) => agent.id)
  if (!rolesEqual(Object.keys(roles), ids)) return { ok: false, reason: 'Роли переданы не для тех агентов, что в составе.' }
  const next = []
  for (const agent of agents) {
    const wanted = roles[agent.id]
    if (!Array.isArray(wanted) || !wanted.every((role) => typeof role === 'string' && ID.test(role)) || new Set(wanted).size !== wanted.length) {
      return { ok: false, reason: `Роли агента ${agent.id} переданы в неверном виде.` }
    }
    const unknown = wanted.filter((role) => !Object.hasOwn(roleDefs, role))
    if (unknown.length) return { ok: false, reason: `Таких ролей нет в реестре: ${unknown.join(', ')}.` }
    const holdable = new Set(rolesItCanHold(agent, roleDefs))
    const beyond = wanted.filter((role) => !holdable.has(role))
    if (beyond.length) return { ok: false, reason: `Агенту ${agent.id} не хватает способностей для ролей: ${beyond.join(', ')}.` }
    next.push({ ...agent, roles: wanted })
  }
  return { ok: true, agents: next }
}

function independenceGate(agents, roleDefs) {
  const report = independenceReport({ agents, roleDefs })
  if (!report.problems.length) return { ok: true, report }
  return { ok: false, report, reason: `Работу некому будет проверить, кроме автора: ${report.problems.map((p) => `${p.role} у ${p.author} (нужна роль ${p.reviewer_role} у другого агента)`).join('; ')}.` }
}

function roleChanges(before, after) {
  const changes = []
  for (const agent of after) {
    const was = before.find((b) => b.id === agent.id)?.roles || []
    if (!rolesEqual(was, agent.roles)) changes.push({ field: 'roles', agent: agent.id, from: was, to: agent.roles })
  }
  return changes
}

// What the page needs to draw the editor: for each agent, the roles it can hold at all.
function holdableRoles(agents, roleDefs) {
  return Object.fromEntries(agents.map((agent) => [agent.id, rolesItCanHold(agent, roleDefs)]))
}

// The file is "there" for the panel even when it is a link that points nowhere: such a path is never written.
const present = (file) => {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

// First setup: nothing is recorded yet, so the panel records the composition `collab setup` would — the chosen
// agents with the catalog's roles for them — and only that. `expect` is the word "none": the owner saw "nothing is
// written", and a file that appeared meanwhile makes the request stale instead of being overwritten.
const NOTHING_WRITTEN = 'none'

function evaluateFirstSetup({ agents, lead, singleVendor, roles, machineDir }) {
  if (!Array.isArray(agents) || !agents.length || !agents.every((id) => typeof id === 'string' && ID.test(id))) return { available: false, reason: 'Отметьте хотя бы одного агента.' }
  if (!ID.test(lead || '') || !agents.includes(lead)) return { available: false, reason: 'Ведущий должен быть одним из выбранных агентов.' }
  const roleDefs = machineRoleDefs(machineDir)
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs, include: agents, lead, singleVendor: Boolean(singleVendor) })
  if (!planned.ok) return { available: false, reason: planned.reason }
  const settled = settleRoles({ agents: planned.content.agents, roles, roleDefs })
  if (!settled.ok) return { available: false, reason: settled.reason }
  const gate = independenceGate(settled.agents, roleDefs)
  const content = { ...planned.content, agents: settled.agents }
  const changes = [
    { field: 'agents', from: null, to: content.agents.map((agent) => agent.id).join(', ') },
    { field: 'lead', from: null, to: content.lead },
    { field: 'review_mode', from: null, to: content.review_mode },
    ...content.agents.map((agent) => ({ field: 'roles', agent: agent.id, from: [], to: agent.roles }))
  ]
  const shown = { roles: Object.fromEntries(content.agents.map((agent) => [agent.id, agent.roles])), holdable: holdableRoles(planned.content.agents, roleDefs), independence: gate.report }
  if (!gate.ok) return { available: false, reason: gate.reason, ...shown }
  return { available: true, first_setup: true, changes, expect: NOTHING_WRITTEN, ...shown, _init: { content, machineDir } }
}

function commitFirstSetup({ content, machineDir }) {
  const file = compositionFile(machineDir)
  // Checked again right before writing: a composition that appeared since the page's request was evaluated
  // (`collab setup` in a terminal) is never overwritten — and never removed by the undo below.
  if (present(file)) return { ok: false, reason: 'На машине появился состав, пока вы выбирали: ничего не записано. Обновите страницу.' }
  const briefings = content.agents.map((agent) => agent.briefing_file).filter(Boolean).map((relative) => join(machineDir, relative))
  const already = new Set(briefings.filter((path) => present(path)))
  const undo = () => {
    try { rmSync(file, { force: true }) } catch { /* nothing more can be done from here */ }
    for (const path of briefings) if (!already.has(path)) try { rmSync(path, { force: true }) } catch { /* same */ }
  }
  try {
    writeComposition(machineDir, content, { catalogDir: DEFAULT_CONFIG_DIR })
    const problems = registryProblems(machineDir)
    if (problems.length) {
      undo()
      return { ok: false, reason: `Запись отменена, реестр не прошёл проверку: ${problems.join('; ')}` }
    }
    return { ok: true, expect: fingerprint(readFileSync(file)) }
  } catch (error) {
    undo()
    return { ok: false, reason: `Запись отменена, созданное убрано: ${error.message}` }
  }
}

export function evaluateApply({ agents, lead, singleVendor, roles = null, machineDir }) {
  const file = machineDir ? compositionFile(machineDir) : null
  if (file && !present(file)) return evaluateFirstSetup({ agents, lead, singleVendor, roles, machineDir })
  if (!file) return { available: false, reason: 'Каталог настроек машины не задан.' }
  if (lstatSync(file).isSymbolicLink()) return { available: false, reason: 'agents.json — символическая ссылка: панель такой файл не переписывает.' }
  const raw = readFileSync(file)
  let current
  try {
    current = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { available: false, reason: `Файл состава не читается: ${error.message}` }
  }
  const ids = (current.agents || []).map((agent) => agent.id)
  // Each entry is one agent id: a single string "a,b" must not pass for two.
  if (!Array.isArray(agents) || !agents.every((id) => typeof id === 'string' && ID.test(id)) || [...agents].sort().join(',') !== [...ids].sort().join(',')) {
    return { available: false, reason: 'Выбранный набор агентов отличается от записанного. Панель меняет только ведущего и режим ревью; состав агентов меняется командой в терминале.' }
  }
  if (!ID.test(lead || '') || !ids.includes(lead)) return { available: false, reason: 'Ведущий должен быть одним из записанных агентов.' }
  const roleDefs = machineRoleDefs(machineDir)
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs, include: ids, lead, singleVendor: Boolean(singleVendor) })
  if (!planned.ok) return { available: false, reason: planned.reason }
  const written = current.agents || []
  const settled = settleRoles({ agents: written, roles, roleDefs })
  if (!settled.ok) return { available: false, reason: settled.reason }
  const gate = independenceGate(settled.agents, roleDefs)
  const shown = { roles: Object.fromEntries(settled.agents.map((agent) => [agent.id, agent.roles || []])), holdable: holdableRoles(written, roleDefs), independence: gate.report }
  if (!gate.ok) return { available: false, reason: gate.reason, ...shown }
  const changes = []
  if ((current.lead || null) !== planned.content.lead) changes.push({ field: 'lead', from: current.lead || null, to: planned.content.lead })
  if ((current.review_mode || null) !== planned.content.review_mode) changes.push({ field: 'review_mode', from: current.review_mode || null, to: planned.content.review_mode })
  changes.push(...roleChanges(written, settled.agents))
  return {
    available: true,
    changes,
    expect: fingerprint(raw),
    revert: evaluateRevert(machineDir),
    ...shown,
    _next: { current, raw, lead: planned.content.lead, review_mode: planned.content.review_mode, agents: settled.agents }
  }
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// "Вернуть прежний" gives back the lead and the review mode of the saved composition and NOTHING else: if the
// agents or their roles differ from the saved one (the owner ran `collab setup` in between), there is nothing the
// panel may put back.
function evaluateRevert(machineDir) {
  const file = compositionFile(machineDir)
  const previous = previousFile(machineDir)
  if (!existsSync(file) || !existsSync(previous)) return { available: false, reason: 'Прежнего состава нет: возвращать нечего.' }
  if (lstatSync(file).isSymbolicLink() || lstatSync(previous).isSymbolicLink()) return { available: false, reason: 'Файл состава — символическая ссылка: панель его не переписывает.' }
  const raw = readFileSync(file)
  const mark = writtenMarkFile(machineDir)
  // The mark binds both files: line 1 is what the panel wrote, line 2 is the copy it saved. Either one changed
  // outside the panel, and there is nothing trustworthy to go back to.
  const [lastWritten = null, lastSaved = null] = present(mark) && lstatSync(mark).isFile() ? readFileSync(mark, 'utf8').trim().split('\n') : []
  if (!lastWritten || !lastSaved) {
    return { available: false, reason: 'Прежний состав сохранён до того, как панель стала отмечать записанное: вернуть его отсюда нельзя. Следующее применение сохранит копию, которую можно вернуть.' }
  }
  if (lastWritten !== fingerprint(raw)) {
    return { available: false, reason: 'Состав изменился после применения из панели (например, командой collab setup): возврат отменил бы это изменение.' }
  }
  if (lastSaved !== fingerprint(readFileSync(previous))) {
    return { available: false, reason: 'Сохранённая копия прежнего состава изменена вне панели: возвращать её нельзя.' }
  }
  let current
  let before
  try {
    current = JSON.parse(raw.toString('utf8'))
    before = JSON.parse(readFileSync(previous, 'utf8'))
  } catch (error) {
    return { available: false, reason: `Файл состава не читается: ${error.message}` }
  }
  // Only what the panel itself writes comes back: the lead, the review mode and each agent's roles. The agents and
  // everything else about them must be as saved, or the owner changed the composition elsewhere since.
  const withoutRoles = (list = []) => list.map(({ roles: _roles, ...rest }) => rest)
  if (!sameJson(withoutRoles(current.agents), withoutRoles(before.agents))) {
    return { available: false, reason: 'Состав агентов изменился после применения (вероятно, командой collab setup): отсюда возвращать нельзя.' }
  }
  const restored = (current.agents || []).map((agent) => ({ ...agent, roles: before.agents.find((b) => b.id === agent.id)?.roles || [] }))
  const gate = independenceGate(restored, machineRoleDefs(machineDir))
  if (!gate.ok) return { available: false, reason: `Прежний состав нарушает независимость ревью: ${gate.reason}` }
  const changes = []
  if ((current.lead || null) !== (before.lead || null)) changes.push({ field: 'lead', from: current.lead || null, to: before.lead || null })
  if ((current.review_mode || null) !== (before.review_mode || null)) changes.push({ field: 'review_mode', from: current.review_mode || null, to: before.review_mode || null })
  changes.push(...roleChanges(current.agents || [], restored))
  if (!changes.length) return { available: false, reason: 'Прежний состав не отличается от текущего: возвращать нечего.' }
  return {
    available: true,
    changes,
    expect: fingerprint(raw),
    _next: { current, raw, lead: before.lead, review_mode: before.review_mode, agents: restored, savedFingerprint: lastSaved }
  }
}

// One write path for apply and revert. The current file becomes the saved one, the new one is checked by the
// registry, and ANY failure — a rejected registry, a file that cannot be read or replaced — puts both files back as
// they were, so a half-done write is never left behind.
function commit(machineDir, { current, raw, lead, review_mode: reviewMode, agents = null, savedFingerprint = null }) {
  const file = compositionFile(machineDir)
  const previous = previousFile(machineDir)
  const keptPrevious = existsSync(previous) ? readFileSync(previous) : null
  const mark = writtenMarkFile(machineDir)
  const keptMark = present(mark) && lstatSync(mark).isFile() ? readFileSync(mark) : null
  const indent = /^\s*\{\n\s+"/.test(raw.toString('utf8')) ? 2 : 0
  // Roles are set on each written agent and nothing else about it moves.
  const nextAgents = agents ? (current.agents || []).map((agent) => ({ ...agent, roles: agents.find((a) => a.id === agent.id)?.roles || agent.roles })) : current.agents
  const next = Buffer.from(`${JSON.stringify({ ...current, lead, review_mode: reviewMode, agents: nextAgents }, null, indent)}\n`)
  const restore = () => {
    try { writeAtomically(file, raw) } catch { /* the original bytes could not be written back; the caller says so */ }
    try {
      if (keptPrevious) writeAtomically(previous, keptPrevious)
      else rmSync(previous, { force: true })
    } catch { /* same */ }
    try {
      if (keptMark) writeAtomically(mark, keptMark)
      else rmSync(mark, { force: true })
    } catch { /* same */ }
  }
  // Compare-before-swap: the file is read again right before it is replaced. A write by another process after the
  // page's request was checked is refused, not overwritten. (A process writing in the few microseconds between this
  // read and the rename below is not caught — there is no lock shared with `collab setup` or an editor.)
  try {
    if (fingerprint(readFileSync(file)) !== fingerprint(raw)) {
      return { ok: false, reason: 'Состав на машине изменился во время записи: ничего не записано. Обновите страницу.' }
    }
    // A revert puts back values read from the saved copy: that copy is checked again too.
    if (savedFingerprint && fingerprint(readFileSync(previous)) !== savedFingerprint) {
      return { ok: false, reason: 'Сохранённая копия прежнего состава изменилась во время возврата: ничего не записано. Обновите страницу.' }
    }
  } catch (error) {
    return { ok: false, reason: `Файл состава не читается: ${error.message}` }
  }
  try {
    writeAtomically(previous, raw)
    writeAtomically(file, next)
    const problems = registryProblems(machineDir)
    if (problems.length) {
      restore()
      return { ok: false, reason: `Запись отменена, реестр не прошёл проверку: ${problems.join('; ')}` }
    }
    writeAtomically(mark, `${fingerprint(next)}\n${fingerprint(raw)}\n`)
    return { ok: true, expect: fingerprint(next) }
  } catch (error) {
    restore()
    return { ok: false, reason: `Запись отменена, прежние файлы возвращены: ${error.message}` }
  }
}

// The internals of an evaluation never leave this module.
export const publicApply = ({ _next, _init, revert, ...visible }) => ({
  ...visible,
  ...(revert ? { revert: (({ _next: inner, ...shown }) => shown)(revert) } : {})
})

export function applySetup({ agents, lead, singleVendor, roles = null, expect, machineDir }) {
  let evaluated
  try {
    evaluated = evaluateApply({ agents, lead, singleVendor, roles, machineDir })
  } catch (error) {
    return { ok: false, reason: `Файл состава не читается: ${error.message}` }
  }
  if (!evaluated.available) return { ok: false, reason: evaluated.reason }
  if (expect !== evaluated.expect) return { ok: false, reason: 'Состав на машине изменился, пока вы выбирали. Обновите страницу и выберите заново.' }
  if (evaluated.first_setup) {
    const first = commitFirstSetup(evaluated._init)
    return first.ok ? { ok: true, changed: true, first_setup: true, changes: evaluated.changes, expect: first.expect } : first
  }
  if (!evaluated.changes.length) return { ok: true, changed: false, changes: [] }
  const done = commit(machineDir, evaluated._next)
  return done.ok ? { ok: true, changed: true, changes: evaluated.changes, expect: done.expect } : done
}

export function revertSetup({ expect, machineDir }) {
  let evaluated
  try {
    evaluated = evaluateRevert(machineDir)
  } catch (error) {
    return { ok: false, reason: `Файл состава не читается: ${error.message}` }
  }
  if (!evaluated.available) return { ok: false, reason: evaluated.reason }
  if (expect !== evaluated.expect) return { ok: false, reason: 'Состав на машине изменился, пока вы смотрели. Обновите страницу.' }
  const done = commit(machineDir, evaluated._next)
  return done.ok ? { ok: true, changes: evaluated.changes, expect: done.expect } : done
}
