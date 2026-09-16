// Agents, roles and capabilities — read from configuration, never from code.
//
// The whole point of this module is that the word "codex" appears in
// config/agents.json and NOWHERE in the protocol. An agent asks for a
// `code_reviewer`; the registry answers with whoever holds that role and is
// available. Adding a third agent is an entry in that file.
//
// WHERE CONFIGURATION COMES FROM, in order:
//   1. an explicit config dir (the configDir PARAMETER — tests; never an env var);
//   2. the trusted project registry entry whose roots contain the journal root;
//   3. the built-in defaults in INSTALL_ROOT/config.
// The merge rule is WHOLE-FILE REPLACEMENT: a file present in 1 or 2 replaces
// the built-in file of the same name, and a missing one falls back to it. There
// is no deep merge, so no partial rule can slip in between two layers. Nothing
// from the project repository itself is ever read. Three things a replacement can
// NOT do: change an agent's adapter (always the built-in one), weaken the
// built-in policy (guardPolicy below), and change the model registry (models.json
// is machine-level — a project copy is ignored and reported).
//
// validateRegistry is PURE and returns every problem it finds. createRegistry is
// the fail-fast wrapper that throws. `collab check-config` calls the first so a
// misconfigured registry is fixed in one pass; the server calls the second and
// exits. Sharing one function is what stops the gate and the runtime from
// disagreeing about what "valid" means.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { CollabConfigError, CODES, CollabError } from './errors.mjs'
import { isValidAgentId } from './ids.mjs'
import { DEFAULT_CONFIG_DIR, DEFAULT_REGISTRY_DIR, safeRealpath } from './paths.mjs'
import { findProject } from './projects.mjs'

export const AGENT_STATUSES = Object.freeze(['available', 'busy', 'waiting', 'offline', 'failed'])

export const CONFIG_FILES = Object.freeze({
  capabilities: 'capabilities.json',
  roles: 'roles.json',
  agents: 'agents.json',
  policy: 'policy.json',
  runners: 'runners.json',
  models: 'models.json'
})

const readConfig = (file, name) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CollabConfigError([`${name}: ${error.code === 'ENOENT' ? `${file} does not exist` : `${file}: ${error.message}`}`])
  }
}

export function validateRegistry(config) {
  const { capabilities, roles, agents, policy, runners, models } = config
  const problems = []
  const warnings = [...(config.meta?.warnings || [])]

  const capIds = new Set(Object.keys(capabilities?.capabilities || {}))
  if (capIds.size === 0) problems.push('capabilities.json declares no capabilities')

  const roleDefs = roles?.roles || {}
  const roleIds = new Set(Object.keys(roleDefs))
  if (roleIds.size === 0) problems.push('roles.json declares no roles')

  for (const [roleId, role] of Object.entries(roleDefs)) {
    if (!role.summary) problems.push(`roles.json: role "${roleId}" has no summary`)
    for (const cap of role.requires || []) {
      if (!capIds.has(cap)) problems.push(`roles.json: role "${roleId}" requires unknown capability "${cap}"`)
    }
  }

  const list = agents?.agents || []
  if (list.length === 0) problems.push('agents.json declares no agents')

  const seen = new Set()
  const roleHolders = new Map()
  const capHolders = new Set()

  for (const agent of list) {
    const where = `agents.json: agent "${agent.id}"`
    if (!isValidAgentId(agent.id)) {
      problems.push(`${where} has an id that is not [a-z][a-z0-9_-]{1,31} — ids become file names and tool arguments`)
    }
    if (seen.has(agent.id)) problems.push(`${where} is declared twice`)
    seen.add(agent.id)

    if (!agent.provider) problems.push(`${where} has no provider`)
    if (!agent.briefing || agent.briefing.length < 40) {
      problems.push(`${where} has no usable briefing — it is what the agent reads about itself in whoami`)
    }
    if (agent.briefing && agent.briefing.length > 8000) {
      problems.push(`${where} briefing is over 8000 chars; it is returned inside a tool result`)
    }

    const caps = new Set(agent.capabilities || [])
    if (caps.size === 0) problems.push(`${where} has no capabilities, so nothing can ever be routed to it`)
    for (const cap of caps) {
      if (!capIds.has(cap)) problems.push(`${where} claims unknown capability "${cap}"`)
      capHolders.add(cap)
    }

    const agentRoles = agent.roles || []
    if (agentRoles.length === 0) problems.push(`${where} holds no roles, so no role-addressed work can reach it`)
    for (const roleId of agentRoles) {
      if (!roleIds.has(roleId)) {
        problems.push(`${where} holds unknown role "${roleId}"`)
        continue
      }
      // The rule that matters most: a role is a promise about what the holder
      // can do. An agent holding a role whose capabilities it lacks is an agent
      // that will be routed work it cannot perform.
      const missing = (roleDefs[roleId].requires || []).filter((c) => !caps.has(c))
      if (missing.length) {
        problems.push(`${where} holds role "${roleId}" but lacks the capabilities it requires: ${missing.join(', ')}`)
      }
      roleHolders.set(roleId, (roleHolders.get(roleId) || 0) + 1)
    }

    const adapter = agent.adapter || {}
    if (!['manual', 'cli'].includes(adapter.kind)) {
      problems.push(`${where} has adapter.kind "${adapter.kind}" — expected "manual" or "cli"`)
    }
    if (adapter.kind === 'cli') {
      if (!adapter.binary) problems.push(`${where} uses the cli adapter without a binary`)
      if (adapter.enabled === true && !adapter.note) {
        problems.push(`${where} enables automatic launching without a note saying who decided that`)
      }
    }
  }

  // An independent review needs somebody other than the author to exist.
  const reviewers = roleHolders.get('code_reviewer') || 0
  if (reviewers < 2 && list.length > 1) {
    warnings.push(
      `only ${reviewers} agent holds "code_reviewer"; a request_review from that same agent can never be routed elsewhere`
    )
  }
  for (const roleId of roleIds) {
    if (!roleHolders.has(roleId)) warnings.push(`role "${roleId}" is held by no agent (reserved for a future agent?)`)
  }
  for (const cap of capIds) {
    if (!capHolders.has(cap)) warnings.push(`capability "${cap}" is held by no agent`)
  }

  problems.push(...validatePolicy(policy))
  if (config.meta?.builtinPolicy) problems.push(...guardPolicy(config.meta.builtinPolicy, policy))
  problems.push(...validateRunners(runners))

  const modelCheck = validateModels(models, { agentIds: seen, policyClasses: new Set(Object.keys(policy?.classes || {})) })
  problems.push(...modelCheck.problems)
  warnings.push(...modelCheck.warnings)

  return { problems, warnings }
}

export function validatePolicy(policy) {
  const problems = []
  if (!policy) return ['policy.json is missing']
  const classes = policy.classes || {}
  const classIds = new Set(Object.keys(classes))
  if (classIds.size === 0) problems.push('policy.json declares no action classes')

  for (const [id, def] of Object.entries(classes)) {
    if (typeof def.severity !== 'number') problems.push(`policy.json: class "${id}" has no numeric severity`)
    if (!def.summary) problems.push(`policy.json: class "${id}" has no summary`)
  }

  const approval = policy.defaults?.approval || {}
  for (const id of classIds) {
    if (!['never', 'mandatory'].includes(approval[id])) {
      problems.push(`policy.json: class "${id}" has no approval default of "never" or "mandatory"`)
    }
  }
  // The reason this exists at all.
  for (const id of ['FINANCIAL', 'PRODUCTION', 'DESTRUCTIVE', 'SECURITY_SENSITIVE']) {
    if (classIds.has(id) && approval[id] !== 'mandatory') {
      problems.push(`policy.json: class "${id}" must require approval — this layer exists to stop it happening on its own`)
    }
  }
  if (!classIds.has(policy.defaults?.unmatched_class)) {
    problems.push('policy.json: defaults.unmatched_class must name a declared class')
  }
  if (approval[policy.defaults?.unmatched_class] !== 'mandatory') {
    problems.push('policy.json: the unmatched class must require approval — a classifier that fails open is not a classifier')
  }

  // Evaluation is max-severity. A class that needs no approval ranking at or
  // above one that does would let a match on it mask the mandatory one.
  const ranked = Object.entries(classes).filter(([, def]) => typeof def.severity === 'number')
  const free = ranked.filter(([id]) => approval[id] === 'never')
  const gated = ranked.filter(([id]) => approval[id] === 'mandatory')
  if (free.length && gated.length) {
    const [freeId, freeDef] = free.reduce((a, b) => (b[1].severity > a[1].severity ? b : a))
    const [gatedId, gatedDef] = gated.reduce((a, b) => (b[1].severity < a[1].severity ? b : a))
    if (freeDef.severity >= gatedDef.severity) {
      problems.push(
        `policy.json: class "${freeId}" needs no approval but has severity ${freeDef.severity}, not below "${gatedId}" ` +
          `(${gatedDef.severity}) which does — a match on it would mask the mandatory class`
      )
    }
  }

  const ruleIds = new Set()
  for (const rule of policy.rules || []) {
    if (!rule.id) problems.push('policy.json: a rule has no id')
    if (ruleIds.has(rule.id)) problems.push(`policy.json: rule "${rule.id}" is declared twice`)
    ruleIds.add(rule.id)
    if (!classIds.has(rule.class)) problems.push(`policy.json: rule "${rule.id}" names unknown class "${rule.class}"`)
    if (!rule.reason) problems.push(`policy.json: rule "${rule.id}" has no reason`)
    try {
      new RegExp(rule.pattern, 'i')
    } catch (error) {
      problems.push(`policy.json: rule "${rule.id}" has an uncompilable pattern: ${error.message}`)
    }
  }
  return problems
}

// A replacement policy may only make classification stricter than the built-in.
//
// Why each check exists (see policy.mjs for the evaluation):
//   - a built-in class removed, ranked lower, or no longer mandatory changes
//     what every built-in rule means;
//   - a built-in rule removed, re-patterned or re-classed weaker stops matching
//     what it matched;
//   - a weaker unmatched_class lets anything unrecognised through;
//   - a NEW rule classed below the built-in unmatched class is the subtle one:
//     an action the built-in table does not recognise falls to the unmatched
//     class (mandatory), but once any rule matches, the strongest match wins
//     even when it is weaker than the default. So `{"pattern": "kubectl",
//     "class": "READ_ONLY"}` would turn "kubectl delete deployment api" from
//     needs-the-owner into nobody-asked. New rules must rank at or above it —
//     unless the rule opts in explicitly with `"lowers_default": true` and a
//     non-empty `"justification"`. Such a rule is accepted, lowers only the
//     text it matches, and is listed by `collab check-config`. The flag means
//     nothing on a built-in rule, class or default: those are checked above
//     regardless.
export function guardPolicy(builtin, project) {
  const problems = []
  if (!builtin || !project) return problems
  const where = 'policy.json (replacement)'
  const bClasses = builtin.classes || {}
  const pClasses = project.classes || {}
  const bSeverity = (cls) => bClasses[cls]?.severity ?? 0
  const pSeverity = (cls) => (typeof pClasses[cls]?.severity === 'number' ? pClasses[cls].severity : -Infinity)
  const bApproval = (cls) => builtin.defaults?.approval?.[cls]
  const pApproval = (cls) => project.defaults?.approval?.[cls]

  for (const [id, def] of Object.entries(bClasses)) {
    if (!pClasses[id]) {
      problems.push(`${where}: built-in class "${id}" is missing — a replacement may add classes, never remove one`)
      continue
    }
    if (pSeverity(id) < def.severity) {
      problems.push(`${where}: class "${id}" has severity ${pClasses[id].severity}, below the built-in ${def.severity}`)
    }
    if (bApproval(id) === 'mandatory' && pApproval(id) !== 'mandatory') {
      problems.push(`${where}: class "${id}" must keep approval "mandatory" as built in, not "${pApproval(id)}"`)
    }
  }

  const bUnmatched = builtin.defaults?.unmatched_class
  const pUnmatched = project.defaults?.unmatched_class
  if (pSeverity(pUnmatched) < bSeverity(bUnmatched)) {
    problems.push(`${where}: defaults.unmatched_class "${pUnmatched}" is weaker than the built-in "${bUnmatched}"`)
  }
  const ttl = (policy) => policy.defaults?.approval_ttl_seconds || 86400
  if (ttl(project) > ttl(builtin)) {
    problems.push(`${where}: approval_ttl_seconds ${ttl(project)} is longer than the built-in ${ttl(builtin)}`)
  }

  const pRules = new Map((project.rules || []).map((rule) => [rule.id, rule]))
  const builtinIds = new Set()
  for (const rule of builtin.rules || []) {
    builtinIds.add(rule.id)
    const mine = pRules.get(rule.id)
    if (!mine) {
      problems.push(`${where}: built-in rule "${rule.id}" is missing — a replacement may add rules, never drop one`)
      continue
    }
    if (mine.pattern !== rule.pattern) {
      problems.push(`${where}: rule "${rule.id}" changes the built-in pattern; add a new rule instead`)
    }
    if (pSeverity(mine.class) < bSeverity(rule.class)) {
      problems.push(`${where}: rule "${rule.id}" is classed "${mine.class}", weaker than the built-in "${rule.class}"`)
    }
    if (rule.never_standing === true && mine.never_standing !== true) {
      problems.push(`${where}: rule "${rule.id}" drops never_standing, so one grant could authorise repeats`)
    }
  }

  const floor = bSeverity(bUnmatched)
  for (const rule of project.rules || []) {
    // A built-in rule id was checked above; lowers_default on it changes nothing.
    if (builtinIds.has(rule.id)) continue
    if (!lowersDefault(project, rule, floor)) continue
    if (rule.lowers_default !== true) {
      problems.push(
        `${where}: added rule "${rule.id}" is classed "${rule.class}", below the built-in unmatched class "${bUnmatched}" — ` +
          'an action the built-in table does not recognise would stop needing the owner once it matched. ' +
          'Refused unless the rule opts in explicitly with "lowers_default": true and a "justification".'
      )
    } else if (typeof rule.justification !== 'string' || !rule.justification.trim()) {
      problems.push(`${where}: added rule "${rule.id}" sets lowers_default but has no justification — say why text matching it may skip the owner`)
    }
  }
  return problems
}

const lowersDefault = (policy, rule, floor) => {
  const severity = policy.classes?.[rule.class]?.severity
  return !(typeof severity === 'number' && severity >= floor) || policy.defaults?.approval?.[rule.class] !== 'mandatory'
}

// The accepted lowering rules of a replacement policy: added (not built-in),
// below the built-in unmatched class, and explicitly opted in.
export function loweringRules(builtin, project) {
  if (!builtin || !project) return []
  const builtinIds = new Set((builtin.rules || []).map((r) => r.id))
  const floor = builtin.classes?.[builtin.defaults?.unmatched_class]?.severity ?? 0
  return (project.rules || [])
    .filter((rule) => !builtinIds.has(rule.id) && rule.lowers_default === true && lowersDefault(project, rule, floor))
    .map(({ id, class: cls, pattern, justification }) => ({ id, class: cls, pattern, justification }))
}

export function validateRunners(runners) {
  const problems = []
  if (!runners) return ['runners.json is missing']
  const defs = runners.runners
  if (!defs || typeof defs !== 'object' || Array.isArray(defs)) {
    return ['runners.json: "runners" must be an object (it may be empty)']
  }
  // An empty set is valid and is the built-in default: a project runs nothing
  // until its registry entry declares what may run.
  for (const [id, def] of Object.entries(defs)) {
    if (!Array.isArray(def.command) || def.command.length === 0) {
      problems.push(`runners.json: runner "${id}" has no command array`)
    }
    if (Array.isArray(def.command) && def.command.some((part) => typeof part !== 'string')) {
      problems.push(`runners.json: runner "${id}" has a non-string command part`)
    }
    // A shell in the command list would turn every argument into a possible
    // second command. There is no reason for one here, ever — covers both
    // POSIX shells and their Windows equivalents (cmd.exe, PowerShell).
    if (Array.isArray(def.command) && /^(sh|bash|zsh|eval|cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?)$/i.test(def.command[0])) {
      problems.push(`runners.json: runner "${id}" invokes a shell; runners take argv, never a shell string`)
    }
    if (def.cwd !== undefined && (typeof def.cwd !== 'string' || isAbsolute(def.cwd) || def.cwd.split(/[\\/]/).includes('..'))) {
      problems.push(`runners.json: runner "${id}" has cwd ${JSON.stringify(def.cwd)} — it must be relative to the working tree`)
    }
    if (!def.summary) problems.push(`runners.json: runner "${id}" has no summary`)
    if (!Number.isInteger(def.timeout_seconds)) problems.push(`runners.json: runner "${id}" has no timeout_seconds`)
    if (def.args && def.args.kind !== 'paths') {
      problems.push(`runners.json: runner "${id}" declares args.kind "${def.args.kind}" — only "paths" is supported`)
    }
  }
  return problems
}

export const MODEL_MATURITY = Object.freeze(['stable', 'preview', 'deprecated', 'unverified'])
export const MODEL_VERIFIED = Object.freeze(['catalog', 'owner', 'unverified'])
const REF = /^[a-z][a-z0-9_-]{1,31}$/

// models.json says which model each LEVEL means, per vendor. Nothing here starts
// anything: the lead session picks and launches, and this is the list it picks
// from. What is checked is that the list cannot lie to a reader — a rung with two
// defaults, a fallback that does not exist, a preview model with nothing to fall
// back to, or a level nobody can serve are all ways the registry would answer a
// routing question with nonsense.
export function validateModels(models, { agentIds = new Set(), policyClasses = new Set() } = {}) {
  const problems = []
  const warnings = []
  if (!models) return { problems: ['models.json is missing'], warnings }

  const levels = models.levels
  if (!levels || typeof levels !== 'object' || Array.isArray(levels)) {
    return { problems: ['models.json: "levels" must be an object'], warnings }
  }
  const ranks = new Map()
  for (const [id, level] of Object.entries(levels)) {
    if (!Number.isFinite(level?.rank)) problems.push(`models.json: level "${id}" has no numeric rank`)
    else if (ranks.has(level.rank)) problems.push(`models.json: levels "${ranks.get(level.rank)}" and "${id}" share rank ${level.rank}`)
    else ranks.set(level.rank, id)
    if (!level?.summary) problems.push(`models.json: level "${id}" has no summary — a level nobody can explain is a level nobody applies`)
  }
  if (!ranks.size) problems.push('models.json declares no levels')

  const floor = models.review_risk_floor || {}
  if (typeof floor !== 'object' || Array.isArray(floor)) problems.push('models.json: "review_risk_floor" must be an object')
  else {
    for (const [cls, level] of Object.entries(floor)) {
      if (!levels[level]) problems.push(`models.json: review_risk_floor["${cls}"] names unknown level "${level}"`)
      if (policyClasses.size && !policyClasses.has(cls)) {
        // A class name that matches nothing would be a floor that never applies:
        // the kind of rule that reads as protection and is not one.
        problems.push(`models.json: review_risk_floor names action class "${cls}", which policy.json does not declare`)
      }
    }
  }

  const vendors = models.vendors
  if (!vendors || typeof vendors !== 'object' || Array.isArray(vendors)) {
    return { problems: [...problems, 'models.json: "vendors" must be an object'], warnings }
  }
  for (const [name, vendor] of Object.entries(vendors)) {
    if (!vendor?.agent) problems.push(`models.json: vendor "${name}" names no agent`)
    else if (!agentIds.has(vendor.agent)) {
      // Not a problem: a project registry may replace agents.json and drop one.
      // The models stay readable, they just have nobody to run them here.
      warnings.push(`models.json: vendor "${name}" names agent "${vendor.agent}", which is not registered for this project`)
    }
    if (vendor?.catalog_file !== null && vendor?.catalog_file !== undefined && typeof vendor.catalog_file !== 'string') {
      problems.push(`models.json: vendor "${name}" has a non-string catalog_file`)
    }
    if (vendor?.verified && !MODEL_VERIFIED.includes(vendor.verified)) {
      problems.push(`models.json: vendor "${name}" has verified "${vendor.verified}" — expected one of ${MODEL_VERIFIED.join(', ')}`)
    }
  }

  const list = models.models
  if (!Array.isArray(list) || list.length === 0) {
    return { problems: [...problems, 'models.json declares no models'], warnings }
  }

  const byRef = new Map()
  const rungs = new Map()
  for (const model of list) {
    const where = `models.json: model "${model?.ref}"`
    if (!REF.test(model?.ref || '')) {
      problems.push(`${where} has a ref that is not [a-z][a-z0-9_-]{1,31} — refs are what the rules and the journal name`)
    }
    if (byRef.has(model?.ref)) problems.push(`${where} is declared twice`)
    byRef.set(model?.ref, model)

    if (!model?.id || typeof model.id !== 'string') problems.push(`${where} has no id`)
    if (!model?.vendor || !vendors[model.vendor]) problems.push(`${where} names unknown vendor "${model?.vendor}"`)
    else if (model.agent && model.agent !== vendors[model.vendor].agent) {
      problems.push(`${where} says agent "${model.agent}" but vendor "${model.vendor}" says "${vendors[model.vendor].agent}"`)
    }
    if (!MODEL_MATURITY.includes(model?.maturity)) {
      problems.push(`${where} has maturity "${model?.maturity}" — expected one of ${MODEL_MATURITY.join(', ')}`)
    }
    if (!MODEL_VERIFIED.includes(model?.verified)) {
      problems.push(`${where} has verified "${model?.verified}" — expected one of ${MODEL_VERIFIED.join(', ')}`)
    }
    // A preview model may be withdrawn or change under you mid-task, so the
    // registry refuses to offer one without somewhere to fall back to.
    if (model?.maturity === 'preview' && !model?.fallback) {
      problems.push(`${where} is preview with no fallback — a preview model is not somewhere work can be left stranded`)
    }
    if (model?.verified !== 'catalog' && vendors[model?.vendor]?.catalog_file) {
      warnings.push(`${where} is not marked verified against the catalog its vendor declares`)
    }

    if (model?.level !== null && model?.level !== undefined) {
      if (!levels[model.level]) problems.push(`${where} claims unknown level "${model.level}"`)
      else {
        const key = `${model.vendor}/${model.level}`
        if (rungs.has(key)) problems.push(`${where} and "${rungs.get(key)}" both claim level ${model.level} for vendor ${model.vendor}`)
        else rungs.set(key, model.ref)
      }
    }
    if (model?.max_level !== null && model?.max_level !== undefined) {
      if (!levels[model.max_level]) problems.push(`${where} claims unknown max_level "${model.max_level}"`)
      else if (levels[model.level] && levels[model.max_level].rank < levels[model.level].rank) {
        problems.push(`${where} has max_level ${model.max_level} below its own level ${model.level}`)
      }
    }
  }

  for (const model of list) {
    if (!model?.fallback) continue
    if (model.fallback === model.ref) {
      problems.push(`models.json: model "${model.ref}" falls back to itself`)
      continue
    }
    if (!byRef.has(model.fallback)) {
      problems.push(`models.json: model "${model.ref}" falls back to "${model.fallback}", which is not declared`)
      continue
    }
    const seenRefs = new Set([model.ref])
    let cursor = byRef.get(model.fallback)
    while (cursor?.fallback) {
      if (seenRefs.has(cursor.ref)) {
        problems.push(`models.json: the fallback chain from "${model.ref}" loops through "${cursor.ref}"`)
        break
      }
      seenRefs.add(cursor.ref)
      cursor = byRef.get(cursor.fallback)
    }
  }

  for (const id of Object.keys(levels)) {
    if (![...rungs.keys()].some((key) => key.endsWith(`/${id}`))) {
      warnings.push(`models.json: level ${id} has no model on any vendor — work classified there has nowhere to go`)
    }
  }
  for (const agentId of agentIds) {
    if (!list.some((model) => vendors[model?.vendor]?.agent === agentId)) {
      warnings.push(`models.json: agent "${agentId}" has no model, so no level can be named for it`)
    }
  }

  return { problems, warnings }
}

// Adapters decide whether the layer may start a process for an agent, so they
// come from the built-in config only. A replacement agents.json that declares one
// has it ignored (and is told so); an agent unknown to the built-in config is
// inbox-only.
function applyBuiltinAdapters(agentsConfig, builtinAgents, warnings) {
  if (!Array.isArray(agentsConfig?.agents)) return agentsConfig
  const builtin = new Map((builtinAgents?.agents || []).map((a) => [a.id, a]))
  return {
    ...agentsConfig,
    agents: agentsConfig.agents.map((agent) => {
      const effective = builtin.get(agent.id)?.adapter || { kind: 'manual' }
      if (agent.adapter !== undefined && JSON.stringify(agent.adapter) !== JSON.stringify(effective)) {
        warnings.push(
          `agents.json: agent "${agent.id}" declares an adapter; adapters come only from the built-in config, so it is ignored (effective: ${effective.kind})`
        )
      }
      return { ...agent, adapter: effective }
    })
  }
}

// Loads the five files: each from `overrideDir` when present there, otherwise
// from the built-in defaults. `config.meta` (non-enumerable) records where
// every file came from, so briefing files resolve against the directory that
// declared them and the policy guard knows whether it has work to do.
export function loadConfigFrom(overrideDir = null, source = { kind: 'built-in' }) {
  const builtinDir = safeRealpath(DEFAULT_CONFIG_DIR)
  let override = overrideDir ? safeRealpath(resolve(overrideDir)) : null
  if (override === builtinDir) override = null
  if (override && source.kind === 'config-dir' && !existsSync(override)) {
    throw new CollabConfigError([`config directory ${override} does not exist`])
  }

  const config = {}
  const meta = { source, files: {}, dirs: {}, overridden: {}, warnings: [], builtinPolicy: null }
  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    const candidate = override ? join(override, name) : null
    const file = candidate && existsSync(candidate) ? candidate : join(builtinDir, name)
    config[key] = readConfig(file, name)
    meta.files[key] = file
    meta.dirs[key] = dirname(file)
    meta.overridden[key] = file !== join(builtinDir, name)
  }
  if (meta.overridden.agents) {
    config.agents = applyBuiltinAdapters(config.agents, readConfig(join(builtinDir, 'agents.json'), 'agents.json'), meta.warnings)
  }
  if (meta.overridden.policy) meta.builtinPolicy = readConfig(join(builtinDir, 'policy.json'), 'policy.json')
  // Which model a level means is machine-level, like an adapter: a project
  // cannot make a model cheaper, smarter or newer by declaring one, and the only
  // thing a replacement could express is a rung the vendor does not have. So a
  // project copy is read, ignored and reported, and the meta says the built-in
  // file is the one in force.
  if (meta.overridden.models) {
    meta.warnings.push(
      `models.json: the model registry comes only from the built-in config, so ${meta.files.models} is ignored`
    )
    config.models = readConfig(join(builtinDir, 'models.json'), 'models.json')
    meta.files.models = join(builtinDir, 'models.json')
    meta.dirs.models = builtinDir
    meta.overridden.models = false
  }
  Object.defineProperty(config, 'meta', { value: meta, enumerable: false })
  return config
}

// Parameters only. COLLAB_CONFIG_DIR / COLLAB_REGISTRY_DIR are deliberately not
// read: a server's environment can come from a repository's .mcp.json.
export function loadConfig({ journalRoot = null, configDir = undefined, registryDir = DEFAULT_REGISTRY_DIR, home = undefined } = {}) {
  if (configDir) return loadConfigFrom(configDir, { kind: 'config-dir', dir: resolve(configDir) })
  if (journalRoot) {
    const project = findProject(journalRoot, { registry: registryDir, home })
    if (project) {
      return loadConfigFrom(join(project.dir, 'collab'), { kind: 'project', id: project.id, dir: project.dir, registry: registryDir })
    }
  }
  return loadConfigFrom(null, { kind: 'built-in' })
}

// Kept for callers that want one directory (or the defaults) and nothing else.
export function loadRegistryConfig(dir = null) {
  return dir ? loadConfigFrom(dir, { kind: 'config-dir', dir: resolve(dir) }) : loadConfigFrom()
}

// A briefing_file is relative to the config directory whose agents.json
// declared it, and may not leave that directory.
export function briefingPath(config, agent) {
  if (!agent?.briefing_file) return null
  const base = config.meta?.dirs?.agents || DEFAULT_CONFIG_DIR
  const path = resolve(base, agent.briefing_file)
  const rel = relative(base, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return path
}

export function checkBriefings(config) {
  const problems = []
  for (const agent of config.agents?.agents || []) {
    if (!agent.briefing_file) continue
    const path = briefingPath(config, agent)
    if (!path) {
      problems.push(`agents.json: agent "${agent.id}" briefing_file ${agent.briefing_file} leaves its config directory`)
    } else if (!existsSync(path)) {
      problems.push(`agents.json: agent "${agent.id}" points at briefing_file ${path}, which does not exist`)
    }
  }
  return problems
}

export function createRegistry(config) {
  const { problems } = validateRegistry(config)
  if (problems.length) throw new CollabConfigError(problems)

  const byId = new Map(config.agents.agents.map((a) => [a.id, a]))
  const roleDefs = config.roles.roles
  const capDefs = config.capabilities.capabilities

  return {
    config,
    agents: () => [...byId.values()],
    agent(id) {
      const agent = byId.get(id)
      if (!agent) {
        throw new CollabError(CODES.UNKNOWN_AGENT, `no agent "${id}" is registered`, {
          id,
          known: [...byId.keys()]
        })
      }
      return agent
    },
    has: (id) => byId.has(id),
    roles: () => roleDefs,
    role(id) {
      if (!roleDefs[id]) {
        throw new CollabError(CODES.UNKNOWN_ROLE, `no role "${id}" is declared`, { id, known: Object.keys(roleDefs) })
      }
      return roleDefs[id]
    },
    capabilities: () => capDefs,
    assertCapability(id) {
      if (!capDefs[id]) {
        throw new CollabError(CODES.UNKNOWN_CAPABILITY, `no capability "${id}" is declared`, {
          id,
          known: Object.keys(capDefs)
        })
      }
      return capDefs[id]
    },
    hasRole: (agentId, roleId) => (byId.get(agentId)?.roles || []).includes(roleId),
    hasCapability: (agentId, capId) => (byId.get(agentId)?.capabilities || []).includes(capId),
    briefingPath: (agentId) => briefingPath(config, byId.get(agentId)),

    // The routing primitive. Everything that says "find me somebody who can X"
    // goes through here, which is why no caller needs to know an agent's name.
    find({ role = null, capability = null, exclude = [], includeSelf = true, self = null } = {}) {
      if (role) this.role(role)
      if (capability) this.assertCapability(capability)
      return this.agents().filter((agent) => {
        if (exclude.includes(agent.id)) return false
        if (!includeSelf && self && agent.id === self) return false
        if (role && !(agent.roles || []).includes(role)) return false
        if (capability && !(agent.capabilities || []).includes(capability)) return false
        return true
      })
    },

    defaults: () => config.agents.defaults || {}
  }
}

export function loadRegistry(dir = null) {
  return createRegistry(loadRegistryConfig(dir))
}
