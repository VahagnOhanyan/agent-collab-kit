// Agents, roles and capabilities — read from configuration, never from code.
//
// The whole point of this module is that the word "codex" appears in
// tools/collab/config/agents.json and NOWHERE in the protocol. An agent asks
// for a `code_reviewer`; the registry answers with whoever holds that role and
// is available. Adding a third agent is an entry in that file.
//
// validateRegistry is PURE and returns every problem it finds. loadRegistry is
// the fail-fast wrapper that throws. The guard script calls the first so a
// misconfigured registry is fixed in one pass; the server calls the second and
// exits. Sharing one function is what stops the gate and the runtime from
// disagreeing about what "valid" means — the same split backend/mcp/config.js
// makes between assertNotProductionHost and loadConfig.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CollabConfigError, CODES, CollabError } from './errors.mjs'
import { isValidAgentId } from './ids.mjs'
import { CONFIG_DIR } from './paths.mjs'

export const AGENT_STATUSES = Object.freeze(['available', 'busy', 'waiting', 'offline', 'failed'])

const readConfig = (dir, name) => {
  const file = join(dir, name)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new CollabConfigError([`${name}: ${error.message}`])
  }
}

export function validateRegistry({ capabilities, roles, agents, policy, runners }) {
  const problems = []
  const warnings = []

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
  problems.push(...validateRunners(runners))

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

export function validateRunners(runners) {
  const problems = []
  if (!runners) return ['runners.json is missing']
  const defs = runners.runners || {}
  if (Object.keys(defs).length === 0) problems.push('runners.json declares no runners')
  for (const [id, def] of Object.entries(defs)) {
    if (!Array.isArray(def.command) || def.command.length === 0) {
      problems.push(`runners.json: runner "${id}" has no command array`)
    }
    if (Array.isArray(def.command) && def.command.some((part) => typeof part !== 'string')) {
      problems.push(`runners.json: runner "${id}" has a non-string command part`)
    }
    // A shell in the command list would turn every argument into a possible
    // second command. There is no reason for one here, ever.
    if (Array.isArray(def.command) && /^(sh|bash|zsh|eval)$/.test(def.command[0])) {
      problems.push(`runners.json: runner "${id}" invokes a shell; runners take argv, never a shell string`)
    }
    if (!def.summary) problems.push(`runners.json: runner "${id}" has no summary`)
    if (!Number.isInteger(def.timeout_seconds)) problems.push(`runners.json: runner "${id}" has no timeout_seconds`)
    if (def.args && def.args.kind !== 'paths') {
      problems.push(`runners.json: runner "${id}" declares args.kind "${def.args.kind}" — only "paths" is supported`)
    }
  }
  return problems
}

export function loadRegistryConfig(dir = CONFIG_DIR) {
  return {
    capabilities: readConfig(dir, 'capabilities.json'),
    roles: readConfig(dir, 'roles.json'),
    agents: readConfig(dir, 'agents.json'),
    policy: readConfig(dir, 'policy.json'),
    runners: readConfig(dir, 'runners.json')
  }
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

export function loadRegistry(dir = CONFIG_DIR) {
  return createRegistry(loadRegistryConfig(dir))
}
