// An action the policy table does not recognise goes back to the agent, not to the owner (owner, 03.10.2026): no task,
// no approval, a refusal that says how to describe the action. A kind (action_kind) may stand in for a verb; it can
// raise the class the words give, never lower it. Approvals of actions written before kinds keep their fingerprint.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../src/errors.mjs'
import { ACTION_KINDS, classifyAction, fingerprintAction } from '../src/policy.mjs'
import { loadConfigFrom } from '../src/registry.mjs'
import { resolveApproval } from '../src/domain/approvals.mjs'
import { TOOLS } from '../src/mcp/tools.mjs'
import { apis, sandbox } from './helpers.mjs'

const policy = loadConfigFrom().policy

test('an unrecognised action creates nothing and reaches nobody: the agent is told to say what it will do', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const before = (await claude.listTasks({})).length
    await assert.rejects(async () => claude.createTask({ title: 'Stories: the frame is cropped on iPhone Duo' }),
      (e) => e.code === CODES.ACTION_UNRECOGNISED && /a verb and an object/.test(e.message) && /action_kind/.test(e.message)
    )
    await assert.rejects(async () => claude.createTask({ title: 'Story Editor', action: 'Сториз: кадр обрезается на iPhone Duo' }), (e) => e.code === CODES.ACTION_UNRECOGNISED)
    assert.equal((await claude.listTasks({})).length, before, 'no task was created')
    assert.equal(claude.listApprovals({ pending_only: true }).length, 0, 'nothing waits for the owner')
  } finally {
    sbx.cleanup()
  }
})

test('a kind stands in for a verb: edit is ordinary work, delete still needs the owner', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const edit = await claude.createTask({ title: 'Stage 2: model tests', action_kind: 'edit' })
    assert.deepEqual([edit.action_class, edit.requires_approval], ['SAFE_WRITE', false])
    assert.equal((await claude.claimTask({ task_id: edit.id })).task.status, 'in_progress', 'the gate reads the stored kind the same way')
    const drop = await claude.createTask({ title: 'Old fixtures', action_kind: 'delete' })
    assert.deepEqual([drop.action_class, drop.requires_approval], ['DESTRUCTIVE', true])
    await assert.rejects(async () => claude.claimTask({ task_id: drop.id }), (e) => e.code === CODES.APPROVAL_REQUIRED)
  } finally {
    sbx.cleanup()
  }
})

test('a kind never lowers what the words say, and dangerous words still go to the owner without one', () => {
  assert.equal(classifyAction(policy, { summary: 'rotate the api key', kind: 'edit' }).action_class, 'SECURITY_SENSITIVE')
  assert.equal(classifyAction(policy, { summary: 'deploy the backend', kind: 'read' }).action_class, 'PRODUCTION')
  const deploy = classifyAction(policy, 'deploy the backend')
  assert.deepEqual([deploy.action_class, deploy.requires_approval], ['PRODUCTION', true])
  // The classifier itself is unchanged: unrecognised still means "ask" at the gate and for an explicit approval.
  assert.equal(classifyAction(policy, 'frobnicate the widget').requires_approval, true)
})

test('an unknown kind is refused, and every kind maps to a declared class', async () => {
  for (const cls of Object.values(ACTION_KINDS)) assert.ok(policy.classes[cls], cls)
  assert.throws(() => classifyAction(policy, { summary: 'x', kind: 'safe' }), (e) => e.code === CODES.INVALID_INPUT)
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    await assert.rejects(async () => claude.createTask({ title: 'Anything', action_kind: 'harmless' }), (e) => e.code === CODES.INVALID_INPUT)
  } finally {
    sbx.cleanup()
  }
})

test('an action without a kind keeps its old fingerprint, so its approvals stay valid; a kind makes another action', () => {
  assert.equal(fingerprintAction('fix the crop'), fingerprintAction({ summary: 'fix the crop' }))
  assert.notEqual(fingerprintAction({ summary: 'fix the crop', kind: 'edit' }), fingerprintAction('fix the crop'))
  assert.notEqual(fingerprintAction({ summary: 'old data', kind: 'delete' }), fingerprintAction({ summary: 'old data', kind: 'read' }))
})

test('a task with a kind can be approved over MCP by its plain words: request, grant, claim', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const drop = await claude.createTask({ title: 'Old fixtures', action_kind: 'delete' })
    // Over MCP the action is a string: the request names the task's own words, and the task's kind is taken.
    const asked = await claude.requestUserApproval({ task_id: drop.id, action: 'Old fixtures', reason: 'They are unused since the rewrite.' })
    assert.equal(asked.approval?.action?.kind ?? asked.action?.kind, 'delete')
    await resolveApproval(claude.ctx, { approval_id: asked.approval?.id ?? asked.id, decision: 'granted', channel: 'test' })
    assert.equal((await claude.claimTask({ task_id: drop.id })).task.status, 'in_progress', 'the gate accepts the grant')
  } finally {
    sbx.cleanup()
  }
})

test('a kind of equal severity does not replace the class the words gave', () => {
  const buy = classifyAction(policy, { summary: 'buy a subscription', kind: 'deploy' })
  assert.deepEqual([buy.action_class, buy.never_standing], ['FINANCIAL', true])
})

test('a dangerous command in a structured action is not lost when a kind is added', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const task = await claude.createTask({ title: 'Ship it', action: { summary: 'update the build', command: 'deploy the backend to production' }, action_kind: 'edit' })
    assert.deepEqual([task.action_class, task.requires_approval], ['PRODUCTION', true])
    await assert.rejects(async () => claude.claimTask({ task_id: task.id }), (e) => e.code === CODES.APPROVAL_REQUIRED)
  } finally {
    sbx.cleanup()
  }
})

test('update_task cannot replace the action or its kind before the gate reads it', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const task = await claude.createTask({ title: 'Old data', action_kind: 'delete' })
    await claude.updateTask({ task_id: task.id, action: 'read the old data', action_kind: 'read' }).catch(() => null)
    const now = claude.getTask({ task_id: task.id })
    assert.deepEqual([now.action, now.action_class], [{ summary: 'Old data', kind: 'delete' }, 'DESTRUCTIVE'])
  } finally {
    sbx.cleanup()
  }
})

test('an explicit request for approval still accepts an action the table does not recognise', async () => {
  const sbx = sandbox()
  const { claude } = apis(sbx)
  try {
    const asked = await claude.requestUserApproval({ action: 'frobnicate the widget', reason: 'I am not sure this is safe.' })
    const approval = asked.approval || asked
    assert.deepEqual([approval.action_class, approval.requires_approval], ['SECURITY_SENSITIVE', true])
  } finally {
    sbx.cleanup()
  }
})

test('the MCP tools list exactly the kinds the classifier knows', () => {
  const kinds = Object.keys(ACTION_KINDS).sort()
  for (const name of ['create_task', 'request_user_approval']) {
    const tool = TOOLS.find((t) => t.name === name)
    assert.deepEqual([...tool.inputSchema.properties.action_kind.enum].sort(), kinds, name)
  }
})
