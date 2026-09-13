// The money question, tested.
//
// "An agent cannot spend the owner's money on its own" has to be a property, not
// a promise. These tests hold the four mechanisms that make it one:
//   1. classification is not the agent's to make;
//   2. approval is required before work starts;
//   3. a grant is single-use and bound to one action by fingerprint;
//   4. the MCP surface has no tool that can grant one.
// The fourth is asserted against the real tool list in mcp.test.mjs.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertActionAllowed, assertNoSecret, classifyAction, fingerprintAction } from '../src/policy.mjs'
import { loadRegistryConfig } from '../src/registry.mjs'
import { CODES } from '../src/errors.mjs'

const policy = loadRegistryConfig().policy

test('paying for something is FINANCIAL and needs the owner', () => {
  for (const action of [
    'buy a subscription to the flight data API',
    'enable billing on the Google Cloud project',
    'upgrade the plan so we get more minutes',
    'register the domain aweiro.app'
  ]) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, 'FINANCIAL', `"${action}" must be FINANCIAL`)
    assert.equal(verdict.requires_approval, true)
    assert.equal(verdict.never_standing, true, 'a financial grant is never standing')
  }
})

test('touching production needs the owner', () => {
  for (const action of ['deploy the backend', 'submit the build to TestFlight', 'run the migration on the prod database']) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.requires_approval, true, `"${action}"`)
    assert.equal(verdict.action_class, 'PRODUCTION')
  }
})

test('reading and testing need nobody', () => {
  for (const action of [
    'read backend/mcp/registry.js and summarise it',
    'run the gates',
    'run tests for the trip domain',
    'analyse the playback camera code'
  ]) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, 'READ_ONLY', `"${action}"`)
    assert.equal(verdict.requires_approval, false)
  }
})

test('ordinary edits need nobody', () => {
  const verdict = classifyAction(policy, 'refactor the trip presenter and add a test')
  assert.equal(verdict.action_class, 'SAFE_WRITE')
  assert.equal(verdict.requires_approval, false)
})

test('an action that matches nothing is treated as needing approval', () => {
  // A classifier that fails open has not classified anything.
  const verdict = classifyAction(policy, 'frobnicate the widget')
  assert.equal(verdict.requires_approval, true)
  assert.equal(verdict.action_class, policy.defaults.unmatched_class)
  assert.match(verdict.reason, /asks rather than guesses/)
})

test('severity wins over rule order: a safe-sounding sentence with a costly clause is still FINANCIAL', () => {
  // "read" and "buy" both match. First-match-wins would call this READ_ONLY
  // depending on where the rule sits in the file; max-severity cannot.
  const verdict = classifyAction(policy, 'read the docs and then buy the paid tier')
  assert.equal(verdict.action_class, 'FINANCIAL')
  assert.equal(verdict.requires_approval, true)
  assert.ok(verdict.matched.some((m) => m.id === 'read'), 'the read rule did match')
})

test('work on a FINANCIAL action without an approval is refused', () => {
  let error = null
  try {
    assertActionAllowed({ policy, action: 'buy a subscription', approval: null })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.APPROVAL_REQUIRED)
  assert.equal(error.details.action_class, 'FINANCIAL')
  assert.match(error.details.action_fingerprint, /^sha256:[0-9a-f]{32}$/)
})

test('a granted approval for a DIFFERENT action does not authorise this one', () => {
  const granted = {
    id: 'apr_a_000001',
    status: 'granted',
    action_fingerprint: fingerprintAction('buy the flight data plan')
  }
  let error = null
  try {
    assertActionAllowed({ policy, action: 'buy the mapping data plan', approval: granted })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.APPROVAL_INVALID)
  assert.match(error.message, /permission for one thing is not permission for another/)
})

test('a matching, granted, unused approval lets the work start', () => {
  const action = 'buy the flight data plan'
  const granted = { id: 'apr_a_000001', status: 'granted', action_fingerprint: fingerprintAction(action) }
  const verdict = assertActionAllowed({ policy, action, approval: granted })
  assert.equal(verdict.action_class, 'FINANCIAL')
})

test('a used approval cannot be replayed', () => {
  const action = 'buy the flight data plan'
  const used = {
    id: 'apr_a_000001',
    status: 'granted',
    action_fingerprint: fingerprintAction(action),
    consumed_at: '2026-09-10T10:00:00.000Z',
    consumed_by: 'codex'
  }
  let error = null
  try {
    assertActionAllowed({ policy, action, approval: used })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.APPROVAL_INVALID)
  assert.match(error.message, /already used/)
})

test('an expired approval cannot be used', () => {
  const action = 'deploy the backend'
  const expired = {
    id: 'apr_a_000002',
    status: 'granted',
    action_fingerprint: fingerprintAction(action),
    expires_at: '2026-09-09T00:00:00.000Z'
  }
  let error = null
  try {
    assertActionAllowed({ policy, action, approval: expired, now: '2026-09-10T00:00:00.000Z' })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.APPROVAL_INVALID)
  assert.match(error.message, /expired/)
})

test('a denied approval is not a granted one', () => {
  const action = 'buy a subscription'
  let error = null
  try {
    assertActionAllowed({ policy, action, approval: { id: 'apr_x_000001', status: 'denied' } })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.APPROVAL_INVALID)
  assert.match(error.message, /"denied", not "granted"/)
})

test('the fingerprint ignores incidental formatting but not the action', () => {
  assert.equal(fingerprintAction('  buy the plan  '), fingerprintAction('buy the plan'))
  assert.notEqual(fingerprintAction('buy plan A'), fingerprintAction('buy plan B'))
  assert.equal(
    fingerprintAction({ tool: 'Bash', command: 'gh release create', summary: 'cut a release' }),
    fingerprintAction({ tool: 'Bash', command: 'gh release create', summary: 'cut a release' })
  )
})

test('a secret in message content is refused, not warned about', () => {
  const samples = [
    ['sk-abcdefghijklmnopqrstuvwx', 'OpenAI-style'],
    ['ghp_abcdefghijklmnopqrstuvwxyz01', 'GitHub'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS'],
    ['postgresql://tripix:hunter2@db.example.com:5432/x', 'database URL']
  ]
  for (const [sample] of samples) {
    let error = null
    try {
      assertNoSecret(`here it is: ${sample}`, 'message body')
    } catch (e) {
      error = e
    }
    assert.ok(error, `${sample} must be refused`)
    assert.equal(error.code, CODES.SECRET_IN_CONTENT)
  }
})

test('ordinary prose about secrets is not refused', () => {
  // Naming where a secret lives is exactly what agents should do instead of quoting it.
  assert.doesNotThrow(() =>
    assertNoSecret('the seed token is in backend/.env as SEED_SERVICE_TOKEN — do not paste it here', 'message body')
  )
})
