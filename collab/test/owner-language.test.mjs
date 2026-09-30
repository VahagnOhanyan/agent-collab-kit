// The owner's language (agents.json `owner_language`): every agent learns it from whoami and the MCP instructions,
// and writes what the owner reads in it. Without the field nothing changes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi, ownerLanguageRule } from '../src/api.mjs'
import { INSTRUCTIONS } from '../src/mcp/server.mjs'
import { loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { sandbox, tempDir, writeJson } from './helpers.mjs'

const CAPS = Object.keys(loadConfigFrom().capabilities.capabilities)
const BRIEFING = 'A test agent. It reads the journal, takes work and answers reviews like any other agent here.'
const agent = (id, provider) => ({ id, name: id, provider, briefing: BRIEFING, capabilities: CAPS, roles: ['software_engineer', 'code_reviewer'] })
const machine = () => ({ home: '/nowhere', platform: 'darwin', which: (b) => `/usr/bin/${b}`, exists: () => false, read: () => null })

function world(extra) {
  const base = tempDir('collab-language-')
  const sbx = sandbox()
  const machineDir = join(base, 'machine')
  writeJson(join(machineDir, 'agents.json'), { lead: 'claude', review_mode: 'cross_vendor', ...extra, agents: [agent('claude', 'anthropic'), agent('codex', 'openai')] })
  return {
    machineDir,
    api: (id) => createApi({ agentId: id, roots: sbx.roots, machineDir, registryDir: join(base, 'no-registry'), probeEnv: machine() }),
    cleanup: () => { rmSync(base, { recursive: true, force: true }); sbx.cleanup() }
  }
}

test('whoami gives every agent the owner\'s language and what to write in it', () => {
  const w = world({ owner_language: 'ru' })
  try {
    for (const id of ['claude', 'codex']) {
      const me = w.api(id).whoami()
      assert.equal(me.owner_language, 'ru')
      assert.match(me.write_for_owner, /in Russian \(ru\)/)
      assert.match(me.write_for_owner, /descriptions/)
      assert.match(me.write_for_owner, /do not translate/)
    }
  } finally {
    w.cleanup()
  }
})

test('without owner_language there is no rule', () => {
  const w = world({})
  try {
    const me = w.api('claude').whoami()
    assert.equal(me.owner_language, null)
    assert.equal(me.write_for_owner, null)
  } finally {
    w.cleanup()
  }
})

test('a language the registry cannot read is a problem, never a rule', () => {
  const w = world({ owner_language: 'russian' })
  try {
    const problems = validateRegistry(loadConfigFrom([w.machineDir], { kind: 'machine', dir: w.machineDir })).problems
    assert.ok(problems.some((p) => /owner_language "russian"/.test(p)), problems.join('\n'))
    assert.equal(ownerLanguageRule('russian'), null)
    assert.match(ownerLanguageRule('pt-BR'), /in pt-BR:/)
  } finally {
    w.cleanup()
  }
})

test('the MCP instructions every agent sees point at the rule', () => {
  assert.match(INSTRUCTIONS, /owner_language/)
  assert.match(INSTRUCTIONS, /write_for_owner/)
})
