// The person's composition: which agents they have, who leads, who holds which
// role. `collab setup` proposes it from the built-in vendor catalog and what is
// installed on this machine; the person answers; it is written to the machine
// config directory (paths.mjs MACHINE_CONFIG_DIR), outside every repository.
// Nothing here names a vendor: every id, role and capability comes from the
// catalog it is given.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The binary that says an agent is installed: its own `detect`, or its cli
// adapter's binary. An agent with neither cannot be detected and is only
// included when the person names it.
export function detectBinary(agent) {
  return agent.detect || (agent.adapter?.kind === 'cli' ? agent.adapter.binary : null) || null
}

// Whether the agent's program is on this machine: its command on PATH, or — for a program that need not put one there,
// like Cursor's editor on Windows — its own directory in the home (`detect_home`, relative to the home). Advisory: it
// labels the wizard's choice and starts the facts; it never decides on its own who may hold a role.
// Answers what was found (the command's path or the directory), or null.
export function agentInstalled(agent, { which, exists, home }) {
  const binary = detectBinary(agent)
  const onPath = binary ? which(binary) : null
  if (onPath) return onPath
  if (typeof agent.detect_home !== 'string' || agent.detect_home === '') return null
  const dir = join(home, agent.detect_home)
  return exists(dir) ? dir : null
}

// Whether another agent can start this one on a task from its shell: a command the catalog names for that
// (`adapter.headless`, or a cli adapter's `binary`) is on PATH. Installed is not enough — an editor without its
// command-line agent is installed, leads fine (it starts the others), but nobody can start it: work waits in its
// inbox until the owner opens it. Answers the command's path, or null. Advisory, like agentInstalled: it explains
// the wizard's choice and refuses nothing.
export function agentLaunchable(agent, { which }) {
  const adapter = agent.adapter || {}
  const commands = [...(Array.isArray(adapter.headless) ? adapter.headless : []), ...(adapter.kind === 'cli' && adapter.binary ? [adapter.binary] : [])]
  for (const command of commands) {
    const found = which(command)
    if (found) return found
  }
  return null
}

// Every role this agent's capabilities satisfy.
export function rolesItCanHold(agent, roleDefs) {
  const caps = new Set(agent.capabilities || [])
  return Object.entries(roleDefs)
    .filter(([, role]) => (role.requires || []).every((c) => caps.has(c)))
    .map(([id]) => id)
}

// The proposal: every chosen agent with every role it can hold. The owner then
// takes roles away (panel) and the machine's facts cut what the agent cannot do.
export function planComposition({ catalog, roleDefs, include, lead, singleVendor = false }) {
  const byId = new Map((catalog.agents || []).map((a) => [a.id, a]))
  const unknown = include.filter((id) => !byId.has(id))
  if (unknown.length) return { ok: false, reason: `not in the catalog: ${unknown.join(', ')}` }
  if (include.length === 0) return { ok: false, reason: 'no agents chosen' }
  if (!include.includes(lead)) return { ok: false, reason: `the lead "${lead}" is not among the chosen agents` }

  const chosen = include.map((id) => byId.get(id))
  // Every agent is proposed every role its capabilities satisfy ("all, then cut by facts", ADR-0026): the catalog no
  // longer says which vendor does what. The facts on the machine (probe.mjs fitToFacts) cut the proposal after this.
  const roles = new Map(chosen.map((a) => [a.id, rolesItCanHold(a, roleDefs)]))
  const agents = chosen.map((a) => {
    const { adapter, detect, detect_home: detectHome, ...rest } = a
    return { ...rest, roles: roles.get(a.id) }
  })
  // One vendor (by provider) means no reviewer of another model family exists:
  // reviews then go to the same agent in a separate session, and say so.
  const oneVendor = singleVendor || new Set(chosen.map((a) => a.provider)).size === 1
  return {
    ok: true,
    content: {
      '//': "This person's composition: which agents they have, who leads, who holds which role. Written by `collab setup`, editable by hand; a project's own agents.json narrows it.",
      lead,
      review_mode: oneVendor ? 'single_vendor' : 'cross_vendor',
      defaults: catalog.defaults || { lease_seconds: 3600, heartbeat_stale_seconds: 900 },
      agents
    }
  }
}

// Only agents.json (one rename) and the briefing files it points at (a
// briefing_file resolves against the directory that declares it) are written;
// anything else the person keeps in this directory is left alone.
export function writeComposition(dir, content, { catalogDir }) {
  mkdirSync(dir, { recursive: true })
  for (const agent of content.agents) {
    if (!agent.briefing_file) continue
    const from = join(catalogDir, agent.briefing_file)
    if (!existsSync(from)) continue
    mkdirSync(dirname(join(dir, agent.briefing_file)), { recursive: true })
    copyFileSync(from, join(dir, agent.briefing_file))
  }
  const stage = mkdtempSync(join(dir, '.agents-'))
  try {
    writeFileSync(join(stage, 'agents.json'), `${JSON.stringify(content, null, 2)}\n`, 'utf8')
    renameSync(join(stage, 'agents.json'), join(dir, 'agents.json'))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  return join(dir, 'agents.json')
}
