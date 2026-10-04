// A role names the skills that suit it, and an agent that takes work in the role is told. A HINT: nothing is loaded,
// and the layer cannot see which skills the agent has — so a name is only checked for being a plausible one.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createApi } from '../src/api.mjs'
import { fixedClock } from '../src/ids.mjs'
import { loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { join } from 'node:path'
import { FIXTURE_ROLES, sandbox, writeJson } from './helpers.mjs'

// The fixture roles carry no skills; a role with them is what these tests are about.
function world() {
  const sbx = sandbox()
  const roles = structuredClone(FIXTURE_ROLES)
  roles.roles.code_reviewer.skills = ['adversarial-audit']
  writeJson(join(sbx.configDir, 'roles.json'), roles)
  const make = (agentId) => createApi({ agentId, roots: sbx.roots, configDir: sbx.configDir, clock: fixedClock() })
  return { claude: make('claude'), codex: make('codex'), cleanup: sbx.cleanup }
}

test('the built-in roles name only skills the kit itself ships, and none names a project', () => {
  const roles = loadConfigFrom().roles.roles
  const named = new Set(Object.values(roles).flatMap((role) => role.skills || []))
  assert.ok(named.size > 0, 'the built-in roles carry skills')
  for (const name of named) assert.match(name, /^[a-z0-9][a-z0-9:_-]*$/i)
  assert.deepEqual([...named].sort(), ['adversarial-audit', 'handoff', 'ux-critic-review', 'ux-guidance'], 'kit skills only')
})

test('a malformed skills list is a configuration problem, a role without one is not', () => {
  const config = loadConfigFrom()
  assert.deepEqual(validateRegistry(config).problems.filter((p) => /skill/.test(p)), [])

  for (const bad of ['handoff', ['has space'], [''], [7], ['../up'], Array.from({ length: 13 }, (_, i) => `s${i}`)]) {
    const broken = structuredClone(config)
    broken.roles.roles.architect.skills = bad
    const problems = validateRegistry(broken).problems.filter((p) => /skill/.test(p))
    assert.ok(problems.length > 0, `refused: ${JSON.stringify(bad)}`)
  }

  const bare = structuredClone(config)
  delete bare.roles.roles.architect.skills
  assert.deepEqual(validateRegistry(bare).problems.filter((p) => /skill/.test(p)), [])
})

test('taking a task says which skills suit its role; a task without a role says none', async () => {
  const w = world()
  try {
    const reviewed = await w.claude.createTask({ title: 'A review for the reviewer role', action: 'edit a file', role: 'code_reviewer' })
    const claimed = await w.codex.claimTask({ task_id: reviewed.id })
    assert.deepEqual(claimed.suggested_skills, ['adversarial-audit'])

    const bare = await w.claude.createTask({ title: 'A task with no role at all', action: 'edit a file' })
    const taken = await w.claude.claimTask({ task_id: bare.id })
    assert.deepEqual(taken.suggested_skills, [])
  } finally {
    w.cleanup()
  }
})

test('whoami lists the skills for each of the agent\'s roles that names any', () => {
  const w = world()
  try {
    const me = w.codex.whoami()
    assert.ok(me.role_skills.code_reviewer.includes('adversarial-audit'))
    assert.equal(me.role_skills.researcher, undefined, 'a role that names no skills is left out')
  } finally {
    w.cleanup()
  }
})
