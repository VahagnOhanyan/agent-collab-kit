import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { describeProject } from '../collab/src/api.mjs'
import { detectBinary, planComposition, writeComposition } from '../collab/src/composition.mjs'
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

export function detectSetup({ registryDir, machineDir, cwd }) {
  const catalog = loadBuiltinAgents()
  const roles = loadConfigFrom().roles.roles
  const project = describeProject({ cwd, registryDir })
  return {
    catalog: (catalog.agents || []).map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider, roles: agent.roles || [] })),
    installed: (catalog.agents || []).filter((agent) => executableOnPath(detectBinary(agent))).map((agent) => agent.id),
    roles,
    current: { machine: machineComposition(machineDir), project: project.projectId },
    project
  }
}

function command(tokens) {
  return tokens.join(' ')
}

export function previewSetup({ agents, lead, singleVendor, registryDir, machineDir, cwd }) {
  if (!Array.isArray(agents) || !agents.length) return { ok: false, reason: 'choose at least one agent' }
  if (!agents.every((id) => ID.test(id)) || !ID.test(lead || '')) return { ok: false, reason: 'agent ids must use lowercase letters, digits, _ or -' }
  if (singleVendor !== '0' && singleVendor !== '1') return { ok: false, reason: 'single_vendor must be 0 or 1' }

  const catalog = loadBuiltinAgents()
  const roleDefs = loadConfigFrom().roles.roles
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
    apply: publicApply(evaluateApply({ agents, lead, singleVendor: singleVendor === '1', machineDir }))
  }
}

// ── applying the lead and the review mode from the panel ─────────────────────
//
// The ONLY thing the panel writes: `lead` and `review_mode` of the composition
// that already sits on this machine. Who the agents are and which roles they
// hold is not touched, and neither is a first setup — those stay `collab setup`
// at the owner's terminal. The file is parsed, the two fields are set on the
// parsed object and every other key (agents, roles, defaults, notes) is written
// back as it was, in its order.

const compositionFile = (machineDir) => join(machineDir, 'agents.json')
const previousFile = (machineDir) => join(machineDir, 'agents.json.prev')

function writeAtomically(file, bytes) {
  const staged = `${file}.tmp-${process.pid}`
  writeFileSync(staged, bytes)
  renameSync(staged, file)
}

function registryProblems(machineDir) {
  return validateRegistry(loadConfigFrom([machineDir], { kind: 'machine', dir: machineDir })).problems
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

function evaluateFirstSetup({ agents, lead, singleVendor, machineDir }) {
  if (!Array.isArray(agents) || !agents.length || !agents.every((id) => typeof id === 'string' && ID.test(id))) return { available: false, reason: 'Отметьте хотя бы одного агента.' }
  if (!ID.test(lead || '') || !agents.includes(lead)) return { available: false, reason: 'Ведущий должен быть одним из выбранных агентов.' }
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs: loadConfigFrom().roles.roles, include: agents, lead, singleVendor: Boolean(singleVendor) })
  if (!planned.ok) return { available: false, reason: planned.reason }
  const changes = [
    { field: 'agents', from: null, to: planned.content.agents.map((agent) => agent.id).join(', ') },
    { field: 'lead', from: null, to: planned.content.lead },
    { field: 'review_mode', from: null, to: planned.content.review_mode }
  ]
  return { available: true, first_setup: true, changes, expect: NOTHING_WRITTEN, _init: { content: planned.content, machineDir } }
}

function commitFirstSetup({ content, machineDir }) {
  const file = compositionFile(machineDir)
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

export function evaluateApply({ agents, lead, singleVendor, machineDir }) {
  const file = machineDir ? compositionFile(machineDir) : null
  if (file && !present(file)) return evaluateFirstSetup({ agents, lead, singleVendor, machineDir })
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
  const planned = planComposition({ catalog: loadBuiltinAgents(), roleDefs: loadConfigFrom().roles.roles, include: ids, lead, singleVendor: Boolean(singleVendor) })
  if (!planned.ok) return { available: false, reason: planned.reason }
  const changes = []
  if ((current.lead || null) !== planned.content.lead) changes.push({ field: 'lead', from: current.lead || null, to: planned.content.lead })
  if ((current.review_mode || null) !== planned.content.review_mode) changes.push({ field: 'review_mode', from: current.review_mode || null, to: planned.content.review_mode })
  return { available: true, changes, expect: fingerprint(raw), revert: evaluateRevert(machineDir), _next: { current, raw, lead: planned.content.lead, review_mode: planned.content.review_mode } }
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
  let current
  let before
  try {
    current = JSON.parse(raw.toString('utf8'))
    before = JSON.parse(readFileSync(previous, 'utf8'))
  } catch (error) {
    return { available: false, reason: `Файл состава не читается: ${error.message}` }
  }
  if (!sameJson(current.agents, before.agents)) return { available: false, reason: 'Состав агентов или роли изменились после применения (вероятно, командой collab setup): отсюда возвращать нельзя.' }
  const changes = []
  if ((current.lead || null) !== (before.lead || null)) changes.push({ field: 'lead', from: current.lead || null, to: before.lead || null })
  if ((current.review_mode || null) !== (before.review_mode || null)) changes.push({ field: 'review_mode', from: current.review_mode || null, to: before.review_mode || null })
  if (!changes.length) return { available: false, reason: 'Прежний состав не отличается от текущего: возвращать нечего.' }
  return { available: true, changes, expect: fingerprint(raw), _next: { current, raw, lead: before.lead, review_mode: before.review_mode } }
}

// One write path for apply and revert. The current file becomes the saved one, the new one is checked by the
// registry, and ANY failure — a rejected registry, a file that cannot be read or replaced — puts both files back as
// they were, so a half-done write is never left behind.
function commit(machineDir, { current, raw, lead, review_mode: reviewMode }) {
  const file = compositionFile(machineDir)
  const previous = previousFile(machineDir)
  const keptPrevious = existsSync(previous) ? readFileSync(previous) : null
  const indent = /^\s*\{\n\s+"/.test(raw.toString('utf8')) ? 2 : 0
  const next = Buffer.from(`${JSON.stringify({ ...current, lead, review_mode: reviewMode }, null, indent)}\n`)
  const restore = () => {
    try { writeAtomically(file, raw) } catch { /* the original bytes could not be written back; the caller says so */ }
    try {
      if (keptPrevious) writeAtomically(previous, keptPrevious)
      else rmSync(previous, { force: true })
    } catch { /* same */ }
  }
  try {
    writeAtomically(previous, raw)
    writeAtomically(file, next)
    const problems = registryProblems(machineDir)
    if (problems.length) {
      restore()
      return { ok: false, reason: `Запись отменена, реестр не прошёл проверку: ${problems.join('; ')}` }
    }
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

export function applySetup({ agents, lead, singleVendor, expect, machineDir }) {
  let evaluated
  try {
    evaluated = evaluateApply({ agents, lead, singleVendor, machineDir })
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
