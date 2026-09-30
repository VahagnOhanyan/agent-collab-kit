// "All, then cut by facts" at run time (ADR-0026, stage 3): what a running session is given is the configuration in
// force fitted to the machine's facts — before anything is written and whatever a file says — while the owner's file
// is never widened or narrowed behind their back. Plus the review choices that hold when everybody holds every role.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { createApi } from '../src/api.mjs'
import { probeAgent } from '../src/probe.mjs'
import { applyBuiltinAdapters, loadBuiltinAgents, loadConfigFrom, validateRegistry } from '../src/registry.mjs'
import { sandbox, tempDir, writeJson } from './helpers.mjs'

const CONFIG = loadConfigFrom()
const CAPS = Object.keys(CONFIG.capabilities.capabilities)

function machine({ files = {} } = {}) {
  return {
    home: '/nowhere',
    platform: 'darwin',
    which: (binary) => `/usr/bin/${binary}`,
    exists: (file) => file === '/Applications/Xcode.app' || Object.hasOwn(files, file),
    read: (file) => (Object.hasOwn(files, file) ? files[file] : null)
  }
}
const READ_ONLY_CODEX = { '/nowhere/.codex/config.toml': 'sandbox_mode = "read-only"\n' }
const BRIEFING = 'A test agent. It reads the journal, takes work and answers reviews like any other agent here.'

function world({ agents = null } = {}) {
  const base = tempDir('collab-stage3-')
  const sbx = sandbox()
  const machineDir = join(base, 'machine')
  if (agents) writeJson(join(machineDir, 'agents.json'), { lead: agents[0].id, review_mode: 'cross_vendor', agents })
  const api = (agentId, probeEnv = machine()) => createApi({ agentId, roots: sbx.roots, machineDir, registryDir: join(base, 'no-registry'), probeEnv })
  return { api, cleanup: () => { rmSync(base, { recursive: true, force: true }); sbx.cleanup() } }
}

test('before any composition is written, the catalog in force is fitted to the facts', () => {
  const w = world()
  try {
    const readOnly = machine({ files: READ_ONLY_CODEX })
    const codex = w.api('codex', readOnly).whoami()
    assert.ok(!codex.capabilities.includes('modify_code'), 'a read-only session is not routable for writing')
    assert.ok(!codex.roles.includes('software_engineer'))
    assert.ok(codex.roles.includes('code_reviewer'))
    assert.ok(!codex.capabilities.includes('run_application'), 'a read-only session runs nothing')
    const claude = w.api('claude', readOnly)
    assert.ok(claude.whoami().unverified_capabilities.includes('run_application'), 'running an application is not confirmed: said so')
    assert.deepEqual(claude.registry.find({ capability: 'modify_code' }).map((a) => a.id), ['claude'])
    const conflicts = claude.doctor().fact_conflicts
    assert.ok(conflicts.some((c) => c.agent === 'codex' && c.role === 'software_engineer'), 'doctor names what the catalog would give and the facts rule out')
  } finally {
    w.cleanup()
  }
})

test('a written composition is fitted at run time and never widened: an agent without capabilities gets none', () => {
  const catalog = loadBuiltinAgents()
  const claude = { ...catalog.agents.find((a) => a.id === 'claude') }
  delete claude.adapter
  // The owner's file: codex with only reviewing capabilities and one role.
  const codex = { id: 'codex', name: 'Codex CLI', provider: 'openai', briefing: BRIEFING, capabilities: ['read_code', 'review_code', 'inspect_git'], roles: ['code_reviewer'] }
  const w = world({ agents: [claude, codex] })
  try {
    const seen = w.api('codex').whoami()
    assert.deepEqual(seen.capabilities, ['read_code', 'review_code', 'inspect_git'])
    assert.deepEqual(seen.roles, ['code_reviewer'])
  } finally {
    w.cleanup()
  }
  // And a file whose agent names no capabilities at all is refused, not filled in from the catalog.
  const bare = world({ agents: [claude, { id: 'codex', name: 'Codex CLI', provider: 'openai', briefing: BRIEFING, roles: ['code_reviewer'] }] })
  try {
    assert.throws(() => bare.api('claude'), /has no capabilities/)
  } finally {
    bare.cleanup()
  }
})

test('the vendor ceiling reaches a written composition through the catalog adapter, and cuts there too', () => {
  const builtin = { agents: [{ id: 'codex', adapter: { kind: 'manual', cannot: ['run_application'] } }] }
  const written = { agents: [{ id: 'codex', name: 'Codex CLI', provider: 'openai', capabilities: CAPS, roles: ['code_reviewer'] }] }
  const [codex] = applyBuiltinAdapters(written, builtin, []).agents
  assert.deepEqual(codex.adapter.cannot, ['run_application'])
  assert.equal(probeAgent(codex, CAPS, machine()).capabilities.run_application.status, 'missing')
})

test('a typo in the vendor ceiling is refused, never read as "nothing to subtract"', () => {
  const broken = structuredClone(CONFIG)
  Object.defineProperty(broken, 'meta', { value: CONFIG.meta, enumerable: false })
  broken.agents.agents[0].adapter = { ...broken.agents.agents[0].adapter, cannot: ['run_applicaton'] }
  broken.agents.agents[1].adapter = { ...broken.agents.agents[1].adapter, cannot: 'run_application' }
  const problems = validateRegistry(broken).problems.join(' | ')
  assert.match(problems, /adapter\.cannot names unknown capability "run_applicaton"/)
  assert.match(problems, /adapter\.cannot must be a list/)
})

test('a confirmed reviewer is chosen over an unconfirmed one, even when only the unconfirmed one is running', async () => {
  const base = (id, provider, extra = {}) => ({ id, name: id, provider, briefing: BRIEFING, capabilities: CAPS, roles: ['software_engineer', 'code_reviewer'], ...extra })
  const w = world({
    agents: [
      base('claude', 'anthropic'),
      base('codex', 'openai'),
      base('gemini', 'google', { unverified_roles: ['code_reviewer'] })
    ]
  })
  try {
    // gemini is running (a write marks it seen; a read does not); codex has never been seen.
    await w.api('gemini').createTask({ title: 'Gemini is here', action: 'edit a file' })
    const status = w.api('claude').doctor().agents
    assert.equal(status.find((a) => a.id === 'gemini').runtime_status !== 'offline', true, 'the test really has a running unconfirmed holder')
    assert.equal(status.find((a) => a.id === 'codex').runtime_status, 'offline')
    const author = w.api('claude')
    const task = await author.createTask({ title: 'Some work', action: 'edit a file' })
    await author.claimTask({ task_id: task.id })
    const review = await author.requestReview({ task_id: task.id })
    assert.equal(review.routed_to, 'codex')
  } finally {
    w.cleanup()
  }
})

test('another agent of the same vendor must name a different, not weaker model, and is recorded as same_vendor', async () => {
  const two = (id) => ({ id, name: id, provider: 'openai', briefing: BRIEFING, capabilities: CAPS, roles: ['software_engineer', 'code_reviewer'] })
  const w = world({ agents: [two('codex'), two('codex_two')] })
  try {
    const author = w.api('codex')
    const task = await author.createTask({ title: 'Same vendor', action: 'edit a file' })
    await author.claimTask({ task_id: task.id })
    await assert.rejects(author.requestReview({ task_id: task.id }), /same vendor/)
    const review = await author.requestReview({ task_id: task.id, author_model: 'terra', reviewer_model: 'sol' })
    assert.deepEqual([review.routed_to, review.review.independence, review.review.reviewer_model], ['codex_two', 'same_vendor', 'sol'])
  } finally {
    w.cleanup()
  }
})
