import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { describeProject } from '../collab/src/api.mjs'
import { detectBinary, planComposition } from '../collab/src/composition.mjs'
import { loadBuiltinAgents, loadConfigFrom } from '../collab/src/registry.mjs'

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

function machineComposition(machineDir) {
  const file = machineDir ? join(machineDir, 'agents.json') : null
  if (!file || !existsSync(file)) return null
  try {
    const content = JSON.parse(readFileSync(file, 'utf8'))
    return {
      lead: content.lead || null,
      review_mode: content.review_mode || null,
      agents: (content.agents || []).map((agent) => ({ id: agent.id, roles: agent.roles || [] }))
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
    commands
  }
}
