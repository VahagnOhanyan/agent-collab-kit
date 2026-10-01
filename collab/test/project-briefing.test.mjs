// A project's own rules for an agent live beside its config in the TRUSTED
// registry, apart from the composition: what is proved here is that they reach
// the agent through whoami, that only a registered project has any, that a link
// or an oversized file is not followed or shown, and that the repository can
// never supply them.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { checkBriefings, loadBuiltinAgents, loadConfig, PROJECT_BRIEFING_MAX } from '../src/registry.mjs'
import { gitRepo, initialisedJournal, linkForTest, tempDir, writeJson } from './helpers.mjs'

function fixture() {
  const base = tempDir('collab-project-briefing-')
  const repo = gitRepo(join(base, 'repo'))
  initialisedJournal(join(repo, '.collab'))
  const registry = join(base, 'registry')
  const project = join(registry, 'demo')
  writeJson(join(project, 'project.json'), { id: 'demo', roots: [repo] })
  const briefings = join(project, 'collab', 'briefings')
  mkdirSync(briefings, { recursive: true })
  const machineDir = join(base, 'no-machine')
  const api = (agentId = 'claude') => createApi({ agentId, cwd: repo, registryDir: registry, machineDir })
  return { base, repo, registry, project, briefings, machineDir, api }
}

test('a project\'s rules for an agent reach it through whoami, beside its briefing', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.briefings, 'claude.project.md'), 'Only the lead pushes.\n')
    const me = f.api('claude').whoami()
    assert.equal(me.project_briefing, 'Only the lead pushes.\n')
    assert.ok(me.briefing.length > 40, 'the agent\'s own briefing is still there')
    assert.equal(f.api('codex').whoami().project_briefing, null, 'another agent gets nothing from this file')
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('without the file there is no project briefing and nothing else changes', () => {
  const f = fixture()
  try {
    assert.equal(f.api().whoami().project_briefing, null)
    assert.deepEqual(checkBriefings(loadConfig({ journalRoot: f.repo, registryDir: f.registry, machineDir: f.machineDir })), [])
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('the file is not followed through a link and is not shown when oversized; doctor names both', (t) => {
  const f = fixture()
  try {
    const secret = join(f.base, 'elsewhere.md')
    writeFileSync(secret, 'SOMETHING ELSE ON THE MACHINE')
    if (!linkForTest(secret, join(f.briefings, 'claude.project.md'))) {
      t.skip('platform: this Windows user may not create a link to a file (needs Developer Mode)')
      return
    }
    writeFileSync(join(f.briefings, 'codex.project.md'), 'x'.repeat(PROJECT_BRIEFING_MAX + 1))
    assert.equal(f.api('claude').whoami().project_briefing, null)
    assert.equal(f.api('codex').whoami().project_briefing, null)
    const problems = checkBriefings(loadConfig({ journalRoot: f.repo, registryDir: f.registry, machineDir: f.machineDir }))
    assert.equal(problems.length, 2, problems.join(' | '))
    assert.match(problems.join(' | '), /claude\.project\.md is not a regular file/)
    assert.match(problems.join(' | '), /codex\.project\.md is over/)
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('the repository cannot supply project rules, and neither can the machine composition', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.repo, '.collab', 'briefings'), { recursive: true })
    writeFileSync(join(f.repo, '.collab', 'briefings', 'claude.project.md'), 'FROM THE REPOSITORY')
    assert.equal(f.api().whoami().project_briefing, null)
    // A machine composition is not a project: even the same layout under it is not read.
    const machine = join(f.base, 'machine')
    mkdirSync(join(machine, 'collab', 'briefings'), { recursive: true })
    writeFileSync(join(machine, 'collab', 'briefings', 'claude.project.md'), 'FROM THE MACHINE')
    writeJson(join(machine, 'agents.json'), loadBuiltinAgents())
    const unregistered = createApi({ agentId: 'claude', cwd: f.repo, registryDir: join(f.base, 'empty-registry'), machineDir: machine })
    assert.equal(unregistered.config.meta.source.kind, 'machine')
    assert.equal(unregistered.whoami().project_briefing, null)
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})
