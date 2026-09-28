// `collab check-config`: the built-in defaults and every registry project, run
// through the SAME validation the server runs at startup, so the gate and the
// runtime can never disagree about what "valid" means. Accepted lowering rules
// (lowers_default) are listed per project, so a deliberate exception to the
// built-in floor is always visible.
//
// It reads configuration only. It never opens a journal, so it is safe to run
// against a project whose `.collab/` is live.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultRegistryDir } from './paths.mjs'
import { listProjects } from './projects.mjs'
import { checkBriefings, loadConfigFrom, loweringRules, validateRegistry } from './registry.mjs'
import { TOOLS } from './mcp/tools.mjs'

export function toolSurfaceProblems(tools = TOOLS) {
  const problems = []
  const names = tools.map((t) => t.name)
  const granting = names.filter((n) => /^(grant|approve|authorise|authorize)|resolve_approval|consume_approval/.test(n))
  if (granting.length) {
    problems.push(`mcp/tools.mjs exposes ${granting.join(', ')} — an agent must not be able to authorise its own action`)
  }
  if (!names.includes('request_user_approval')) {
    problems.push('mcp/tools.mjs has no request_user_approval — an agent would have no way to ask the owner at all')
  }
  for (const tool of tools) {
    if (!tool.inputSchema || tool.inputSchema.type !== 'object') {
      problems.push(`mcp/tools.mjs: tool "${tool.name}" has no object inputSchema; MCP clients require one`)
    }
    if (!tool.description || tool.description.length < 40) {
      problems.push(`mcp/tools.mjs: tool "${tool.name}" has a description too short to guide a model`)
    }
  }
  return problems
}

function check(label, load, { problems = [], warnings = [] } = {}) {
  const report = { label, problems: [...problems], warnings: [...warnings], overridden: [], lowering: [] }
  try {
    const config = load()
    const result = validateRegistry(config)
    report.problems.push(...result.problems, ...checkBriefings(config))
    report.warnings.push(...result.warnings)
    report.overridden = Object.entries(config.meta.overridden)
      .filter(([, replaced]) => replaced)
      .map(([key]) => key)
    report.lowering = config.meta.builtinPolicy ? loweringRules(config.meta.builtinPolicy, config.policy) : []
  } catch (error) {
    report.problems.push(...(error.problems || [error.message]))
  }
  return report
}

export function checkConfig({ projectId = null, registryDir = defaultRegistryDir(), home = homedir() } = {}) {
  const registry = registryDir
  const reports = [check('built-in defaults', () => loadConfigFrom())]

  const entries = listProjects(registry, { home })
  const selected = projectId ? entries.filter((e) => e.id === projectId) : entries
  if (projectId && selected.length === 0) {
    reports.push({ label: `project "${projectId}"`, problems: [`no project "${projectId}" in ${registry}`], warnings: [], overridden: [], lowering: [] })
  }

  const claimedBy = new Map()
  for (const entry of entries) {
    for (const root of entry.realRoots) claimedBy.set(root, [...(claimedBy.get(root) || []), entry.id])
  }

  for (const entry of selected) {
    const label = `project "${entry.id}" (${entry.dir})`
    const duplicates = [...new Set(entry.realRoots)]
      .filter((root) => claimedBy.get(root).length > 1)
      .map((root) => `projects/${entry.id}: root ${root} is also claimed by ${claimedBy.get(root).filter((id) => id !== entry.id).join(', ')}`)
    if (entry.problems.length) {
      reports.push({ label, problems: [...entry.problems, ...duplicates], warnings: entry.warnings, overridden: [], lowering: [] })
      continue
    }
    reports.push(
      check(
        label,
        () => loadConfigFrom(join(entry.dir, 'collab'), { kind: 'project', id: entry.id, dir: entry.dir, registry }),
        { problems: duplicates, warnings: entry.warnings }
      )
    )
  }

  const surface = toolSurfaceProblems()
  return {
    registry,
    reports,
    surface,
    tools: TOOLS.length,
    ok: surface.length === 0 && reports.every((r) => r.problems.length === 0)
  }
}
