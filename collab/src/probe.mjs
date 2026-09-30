// What an agent can do ON THIS MACHINE, read from facts rather than from the
// catalog's say-so. Every capability gets one of three answers:
//
//   confirmed — a fact shows it (the agent's program is installed; MCP servers are registered for it);
//   missing   — a fact rules it out: the agent's own configuration makes its session read-only (the top-level
//               `sandbox_mode`; a selected profile or a per-call `-s` is not read — a known limit, ADR-0026);
//   unknown   — nothing here can tell. Running and driving an application is the usual case: that the
//               tools exist does not show the agent can use them.
//
// Only `missing` takes a role away. `unknown` leaves the role with a mark, and the owner decides —
// a guess never removes a role, and a guess never confirms one either.
//
// Facts are read through `env` so tests can describe any machine; the defaults read this one.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { which } from './adapters/index.mjs'
import { detectBinary } from './composition.mjs'
import { readMcpServers } from './mcp-servers.mjs'
import { loadBuiltinAgents } from './registry.mjs'

export const CAPABILITY_STATUS = Object.freeze(['confirmed', 'missing', 'unknown'])

// Capabilities that write to the tree or run programs: a read-only session has none of them.
const NEEDS_WRITE_OR_RUN = new Set(['modify_code', 'run_tests', 'run_gates', 'run_application'])

export function machineEnv() {
  return {
    home: homedir(),
    platform: process.platform,
    which,
    exists: existsSync,
    read: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    }
  }
}

// The sandbox the agent's own interactive sessions run in, when its configuration says so. Only a value the
// configuration states is used; an unreadable file answers null (nothing is known), never "read-only".
function sessionSandbox(agent, env) {
  if (binaryOf(agent) !== 'codex') return null
  const text = env.read(join(env.home, '.codex', 'config.toml'))
  if (!text) return null
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break // top-level keys only: a [profile] table does not set the default
    const match = /^\s*sandbox_mode\s*=\s*"([^"]+)"/.exec(line)
    if (match) return match[1]
  }
  return null
}

// Anything an application can be run and looked at with: a simulator toolchain or a browser.
function applicationRunners(env) {
  const found = []
  if (env.platform === 'darwin') {
    if (env.exists('/Applications/Xcode.app')) found.push('Xcode')
    if (env.exists('/Applications/Safari.app')) found.push('Safari')
    if (env.exists('/Applications/Google Chrome.app')) found.push('Chrome')
  }
  for (const binary of ['google-chrome', 'chromium', 'firefox']) if (env.which(binary)) found.push(binary)
  return found
}

// A written composition drops the catalog's `detect` and adapter fields, so the program is looked up in the
// catalog by the agent's id when the composition does not name it.
function binaryOf(agent) {
  return detectBinary(agent) || detectBinary((loadBuiltinAgents().agents || []).find((known) => known.id === agent.id) || {})
}

export function probeAgent(agent, capabilityIds, env = machineEnv()) {
  const binary = binaryOf(agent)
  const installed = binary ? env.which(binary) : null
  const sandbox = sessionSandbox(agent, env)
  const readOnly = sandbox === 'read-only'
  const runners = applicationRunners(env)
  const mcp = readMcpServers(env.home).filter((server) => server.agents.includes(agent.id))
  const capabilities = {}
  for (const capability of capabilityIds) {
    let answer
    // The vendor's program cannot have it at all (the adapter ceiling, from the catalog): a fact about the program.
    // A registry applies catalog adapters to every agent it loads; an agent passed without one is looked up.
    const adapter = agent.adapter || (loadBuiltinAgents().agents || []).find((known) => known.id === agent.id)?.adapter
    if ((adapter?.cannot || []).includes(capability)) {
      answer = { status: 'missing', reason: `программа ${agent.name || agent.id} этого не умеет (adapter.cannot в каталоге)` }
    } else if (!installed) {
      answer = { status: 'unknown', reason: binary ? `программа ${binary} не найдена на этой машине` : 'у агента нет программы, которую можно найти' }
    } else if (readOnly && NEEDS_WRITE_OR_RUN.has(capability)) {
      answer = { status: 'missing', reason: 'сессия агента настроена только на чтение (sandbox_mode = "read-only")' }
    } else if (capability === 'run_application') {
      // Never `missing`: not finding a simulator or a browser here is an absence of evidence (other browsers, other
      // install paths, a PATH trimmed for this process), not a fact that rules the agent out.
      answer = {
        status: 'unknown',
        reason: runners.length
          ? `на машине есть ${runners.join(', ')}, но умеет ли агент запускать и смотреть приложение, проверить нельзя`
          : 'симулятор или браузер здесь не найден, а умеет ли агент запускать приложение, проверить нельзя'
      }
    } else if (capability === 'use_mcp_tool') {
      answer = mcp.length
        ? { status: 'confirmed', reason: `подключены MCP-серверы: ${mcp.map((server) => server.name).join(', ')}` }
        : { status: 'unknown', reason: 'в настройках агента не найдено общих MCP-серверов' }
    } else {
      answer = { status: 'confirmed', reason: `программа установлена (${installed})` }
    }
    capabilities[capability] = answer
  }
  return { agent: agent.id, installed: Boolean(installed), sandbox, capabilities }
}

// The facts for a whole composition, one place for the panel, `collab setup` and doctor to ask.
export function factsFor(agents, { roleDefs, capabilityIds, env = machineEnv() }) {
  return Object.fromEntries(agents.map((agent) => {
    const probe = probeAgent(agent, capabilityIds, env)
    return [agent.id, { ...probe, ...rolesByFacts(agent, roleDefs, probe) }]
  }))
}

// A proposed composition brought in line with the facts: a role the facts block is taken out, and the roles
// held on an unconfirmed capability are marked. Used for what is PROPOSED (setup, first setup); a composition
// already written is never rewritten behind the owner's back — doctor names the conflict instead.
export function fitToFacts(agents, facts) {
  return agents.map((agent) => {
    const known = facts[agent.id]
    if (!known) return agent
    const roles = (agent.roles || []).filter((role) => known.allowed.includes(role))
    const unverified = roles.filter((role) => known.unverified.includes(role))
    const { unverified_roles: _old, ...rest } = agent
    return unverified.length ? { ...rest, roles, unverified_roles: unverified } : { ...rest, roles }
  })
}

// The configuration IN FORCE for a running session, fitted to the facts on this machine: a capability the facts rule
// out is not routable (find by capability), a role they rule out is not held, and roles on an unconfirmed capability
// are marked. Nothing is written — the owner's file stays as they confirmed it, and doctor names the difference
// (meta.writtenAgents is what the file says). This is what makes "all, then cut by facts" true at run time too,
// including before any composition is written (the catalog in force).
export function fitConfigToFacts(config, env = machineEnv()) {
  const written = config.agents?.agents || []
  const facts = factsFor(written, { roleDefs: config.roles?.roles || {}, capabilityIds: Object.keys(config.capabilities?.capabilities || {}), env })
  const agents = written.map((agent) => {
    const known = facts[agent.id]
    const capabilities = (agent.capabilities || []).filter((capability) => known.capabilities[capability]?.status !== 'missing')
    const roles = (agent.roles || []).filter((role) => known.allowed.includes(role))
    const unverified = [...new Set([...(agent.unverified_roles || []), ...roles.filter((role) => known.unverified.includes(role))])].filter((role) => roles.includes(role))
    const unconfirmedCapabilities = capabilities.filter((capability) => known.capabilities[capability]?.status === 'unknown')
    const { unverified_roles: _old, ...rest } = agent
    return {
      ...rest,
      capabilities,
      roles,
      ...(unverified.length ? { unverified_roles: unverified } : {}),
      unverified_capabilities: unconfirmedCapabilities
    }
  })
  const fitted = { ...config, agents: { ...config.agents, agents } }
  Object.defineProperty(fitted, 'meta', { value: { ...config.meta, facts, writtenAgents: written }, enumerable: false })
  return fitted
}

// Held roles the facts now block: the composition promises work this agent cannot do here.
export function factConflicts(agents, facts) {
  const conflicts = []
  for (const agent of agents) {
    for (const blocked of facts[agent.id]?.blocked || []) {
      if ((agent.roles || []).includes(blocked.role)) conflicts.push({ agent: agent.id, role: blocked.role, reasons: blocked.reasons })
    }
  }
  return conflicts
}

// Which roles the facts allow. A role is BLOCKED when a capability it requires is missing, or when the agent's
// composition does not declare it at all; UNVERIFIED when one it requires is unknown; allowed otherwise.
export function rolesByFacts(agent, roleDefs, probe) {
  const declared = new Set(agent.capabilities || [])
  const allowed = []
  const unverified = []
  const blocked = []
  for (const [role, definition] of Object.entries(roleDefs)) {
    const requires = definition.requires || []
    const undeclared = requires.filter((capability) => !declared.has(capability))
    const missing = requires.filter((capability) => probe.capabilities[capability]?.status === 'missing')
    if (undeclared.length || missing.length) {
      blocked.push({
        role,
        reasons: [
          ...undeclared.map((capability) => `нет способности ${capability} в составе`),
          ...missing.map((capability) => `${capability}: ${probe.capabilities[capability].reason}`)
        ]
      })
      continue
    }
    allowed.push(role)
    const unknown = requires.filter((capability) => probe.capabilities[capability]?.status === 'unknown')
    if (unknown.length) unverified.push(role)
  }
  return { allowed, unverified, blocked }
}
