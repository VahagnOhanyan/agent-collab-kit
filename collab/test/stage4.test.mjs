// Stage 4 (ADR-0026): an agent suspends a role it cannot do here — it stops counting for it at once, its task goes
// back to the queue, and only the owner gives it back. And what the machine cannot check, the owner confirms:
// a confirmed capability counts as checked; a fact that rules it out still wins.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { probeAgent } from '../src/probe.mjs'
import { loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { runCli, sandbox, tempDir, writeJson } from './helpers.mjs'

const CAPS = Object.keys(loadConfigFrom().capabilities.capabilities)
const BRIEFING = 'A test agent. It reads the journal, takes work and answers reviews like any other agent here.'

function machine({ files = {} } = {}) {
  return {
    home: '/nowhere',
    platform: 'darwin',
    which: (binary) => `/usr/bin/${binary}`,
    exists: (file) => file === '/Applications/Xcode.app' || Object.hasOwn(files, file),
    read: (file) => (Object.hasOwn(files, file) ? files[file] : null)
  }
}

function world(agents) {
  const base = tempDir('collab-stage4-')
  const sbx = sandbox()
  const machineDir = join(base, 'machine')
  writeJson(join(machineDir, 'agents.json'), { lead: agents[0].id, review_mode: 'cross_vendor', agents })
  const api = (agentId, env = machine()) => createApi({ agentId, roots: sbx.roots, machineDir, registryDir: join(base, 'no-registry'), probeEnv: env })
  return { api, sbx, machineDir, cleanup: () => { rmSync(base, { recursive: true, force: true }); sbx.cleanup() } }
}

const agent = (id, provider, roles, extra = {}) => ({ id, name: id, provider, briefing: BRIEFING, capabilities: CAPS, roles, ...extra })
const TWO = () => [agent('claude', 'anthropic', ['software_engineer', 'code_reviewer']), agent('codex', 'openai', ['software_engineer', 'code_reviewer'])]

test('a suspended role stops counting for the agent at once, and its task that needs the role goes back to the queue', async () => {
  const w = world(TWO())
  try {
    const codex = w.api('codex')
    const task = await codex.createTask({ title: 'Some backend work', role: 'software_engineer', action: 'edit a file' })
    await codex.claimTask({ task_id: task.id })
    const done = await codex.suspendRole({ role: 'software_engineer', reason: 'The test runner cannot start in my session here.', task_id: task.id })
    assert.equal(done.released_task, task.id)
    const back = await codex.getTask({ task_id: task.id })
    assert.deepEqual([back.status, back.owner], ['created', null])
    const fresh = w.api('claude')
    assert.deepEqual(fresh.registry.find({ role: 'software_engineer' }).map((a) => a.id), ['claude'])
    assert.equal(fresh.registry.hasRole('codex', 'software_engineer'), false)
    assert.deepEqual(w.api('codex').whoami().suspended_roles.map((s) => s.role), ['software_engineer'])
    await assert.rejects(w.api('codex').claimTask({ task_id: task.id }), /software_engineer/)
    const listed = fresh.doctor().suspended_roles
    assert.deepEqual(listed.map((s) => [s.agent, s.role, s.restore]), [['codex', 'software_engineer', 'collab role restore codex software_engineer']])
  } finally {
    w.cleanup()
  }
})

test('suspending needs a reason and a role the agent holds', async () => {
  const w = world(TWO())
  try {
    const codex = w.api('codex')
    await assert.rejects(codex.suspendRole({ role: 'software_engineer', reason: 'no' }), /say why/)
    await assert.rejects(codex.suspendRole({ role: 'architect', reason: 'I cannot record decisions here at all.' }), /does not hold/)
    await assert.rejects(codex.suspendRole({ role: 'wizard', reason: 'I cannot record decisions here at all.' }), /no role "wizard"/)
  } finally {
    w.cleanup()
  }
})

test('the owner gives the role back; the CLI refuses without a terminal; unticking the role ends the suspension', async () => {
  const w = world(TWO())
  try {
    await w.api('codex').suspendRole({ role: 'code_reviewer', reason: 'Reviews time out in my sandbox every time.' })
    const cli = runCli(['role', 'restore', 'codex', 'code_reviewer'], { cwd: w.sbx.roots.journalRoot, options: { machineDir: w.machineDir, registryDir: join(w.machineDir, 'no-registry') } })
    assert.equal(cli.status, 3, cli.stdout + cli.stderr)
    assert.match(cli.stderr, /interactive terminal/)
    await w.api('claude').restoreRole({ agent_id: 'codex', role: 'code_reviewer' })
    assert.equal(w.api('claude').registry.hasRole('codex', 'code_reviewer'), true)
    await assert.rejects(w.api('claude').restoreRole({ agent_id: 'codex', role: 'code_reviewer' }), /no suspended role/)
  } finally {
    w.cleanup()
  }
  // Taking a suspended role away for good is the owner unticking it: the suspension is then simply over.
  const agents = TWO()
  const v = world(agents)
  try {
    await v.api('codex').suspendRole({ role: 'software_engineer', reason: 'The test runner cannot start in my session here.' })
    writeJson(join(v.machineDir, 'agents.json'), { lead: 'claude', review_mode: 'cross_vendor', agents: [agents[0], { ...agents[1], roles: ['code_reviewer'] }] })
    assert.deepEqual(v.api('claude').doctor().suspended_roles, [])
  } finally {
    v.cleanup()
  }
})

test('the owner confirms what the machine cannot check; a fact that rules it out still wins', () => {
  const claude = { ...loadBuiltinAgents().agents.find((a) => a.id === 'claude'), confirmed_capabilities: ['run_application'] }
  assert.equal(probeAgent(claude, CAPS, machine()).capabilities.run_application.status, 'confirmed')
  assert.match(probeAgent(claude, CAPS, machine()).capabilities.run_application.reason, /владельцем/)
  const codex = { ...loadBuiltinAgents().agents.find((a) => a.id === 'codex'), confirmed_capabilities: ['run_application'] }
  const readOnly = machine({ files: { '/nowhere/.codex/config.toml': 'sandbox_mode = "read-only"\n' } })
  assert.equal(probeAgent(codex, CAPS, readOnly).capabilities.run_application.status, 'missing')
})

test('a confirmation the facts now rule out does not break the machine: the session starts, the capability is simply gone', () => {
  const w = world([agent('claude', 'anthropic', ['software_engineer', 'code_reviewer']), agent('codex', 'openai', ['code_reviewer'], { confirmed_capabilities: ['run_application'] })])
  try {
    const readOnly = machine({ files: { '/nowhere/.codex/config.toml': 'sandbox_mode = "read-only"\n' } })
    const codex = w.api('codex', readOnly).whoami()
    assert.equal(codex.capabilities.includes('run_application'), false)
    assert.deepEqual(w.api('claude', readOnly).doctor().fact_conflicts, [], 'a capability, not a role, was ruled out')
  } finally {
    w.cleanup()
  }
})

test('whoami: a confirmed run_application is not in unverified_capabilities; an unconfirmed one is', () => {
  const w = world([agent('claude', 'anthropic', ['software_engineer', 'code_reviewer'], { confirmed_capabilities: ['run_application'] }), agent('codex', 'openai', ['software_engineer', 'code_reviewer'])])
  try {
    assert.equal(w.api('claude').whoami().unverified_capabilities.includes('run_application'), false)
    assert.equal(w.api('codex').whoami().unverified_capabilities.includes('run_application'), true)
  } finally {
    w.cleanup()
  }
})

test('the registry refuses a confirmation of a capability the agent does not have', () => {
  const config = loadConfigFrom()
  const broken = structuredClone(config)
  Object.defineProperty(broken, 'meta', { value: config.meta, enumerable: false })
  broken.agents.agents[0].capabilities = broken.agents.agents[0].capabilities.filter((c) => c !== 'run_application')
  broken.agents.agents[0].roles = broken.agents.agents[0].roles.filter((r) => !(config.roles.roles[r].requires || []).includes('run_application'))
  broken.agents.agents[0].confirmed_capabilities = ['run_application']
  assert.match(validateRegistry(broken).problems.join(' | '), /confirms "run_application" but does not have it/)
})
