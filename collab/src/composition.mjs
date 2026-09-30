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

// Every role this agent's capabilities satisfy.
export function rolesItCanHold(agent, roleDefs) {
  const caps = new Set(agent.capabilities || [])
  return Object.entries(roleDefs)
    .filter(([, role]) => (role.requires || []).every((c) => caps.has(c)))
    .map(([id]) => id)
}

// The proposal. With one agent it holds every role it can — there is nobody
// else. With several, each keeps the catalog's default roles, and any role the
// catalog gave only to an agent left out goes to whoever can hold it.
export function planComposition({ catalog, roleDefs, include, lead, singleVendor = false }) {
  const byId = new Map((catalog.agents || []).map((a) => [a.id, a]))
  const unknown = include.filter((id) => !byId.has(id))
  if (unknown.length) return { ok: false, reason: `not in the catalog: ${unknown.join(', ')}` }
  if (include.length === 0) return { ok: false, reason: 'no agents chosen' }
  if (!include.includes(lead)) return { ok: false, reason: `the lead "${lead}" is not among the chosen agents` }

  const chosen = include.map((id) => byId.get(id))
  const roles = new Map(chosen.map((a) => [a.id, chosen.length === 1 ? rolesItCanHold(a, roleDefs) : [...(a.roles || [])]]))
  if (chosen.length > 1) {
    const held = new Set([...roles.values()].flat())
    const orphaned = [...new Set((catalog.agents || []).flatMap((a) => a.roles || []))].filter((r) => !held.has(r))
    for (const role of orphaned) {
      const holder = chosen.find((a) => rolesItCanHold(a, roleDefs).includes(role))
      if (holder) roles.get(holder.id).push(role)
    }
  }
  const agents = chosen.map((a) => {
    const { adapter, detect, ...rest } = a
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
