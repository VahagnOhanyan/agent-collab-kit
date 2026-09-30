// Known vendor CLIs found on this machine that the catalog has no adapter for — the skill vendor-probe's candidate
// list against collab/config/agents.json. Only a PATH lookup: no CLI is started and nothing is written. Each comes
// with the sentence to give that agent, so on a machine where it is the only agent it studies itself.

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DEFAULT_CONFIG_DIR } from './paths.mjs'

// The kit root is the parent of collab/; the skill sits next to it, in the same release.
const PROBE = join(DEFAULT_CONFIG_DIR, '..', '..', 'skills', 'vendor-probe', 'probe.mjs')
const RELEASE_SKILL = join(DEFAULT_CONFIG_DIR, '..', '..', 'skills', 'vendor-probe', 'SKILL.md')

// The path an agent is told to read: through ~/.agent-kit/current when that is this same file — a release directory
// is replaced by the next install, the link is not.
function stableSkillPath() {
  const current = join(homedir(), '.agent-kit', 'current', 'skills', 'vendor-probe', 'SKILL.md')
  try {
    if (realpathSync(current) === realpathSync(RELEASE_SKILL)) return current
  } catch { /* not installed through the link: the release path is what there is */ }
  return RELEASE_SKILL
}
const SKILL = stableSkillPath()

// `probeFile` and `agentsFile` are for tests; `env` is the PATH the lookup uses.
export async function unadaptedVendors({ probeFile = PROBE, agentsFile = join(DEFAULT_CONFIG_DIR, 'agents.json'), env = process.env } = {}) {
  let probe
  try {
    probe = await import(pathToFileURL(probeFile).href)
  } catch {
    return [] // no skill in this install: nothing to report, never a failure of the caller
  }
  const skillFile = join(probeFile, '..', 'SKILL.md')
  return (await probe.unadapted({ agentsFile, env })).map((found) => ({
    binary: found.binary,
    vendor: found.vendor,
    path: found.path,
    phrase: probe.probePhrase(found.binary, probeFile === PROBE ? SKILL : skillFile)
  }))
}
