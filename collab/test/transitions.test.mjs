// Invariants of the state-machine table itself, plus the guards.
//
// The five structural assertions are what keep the table from rotting: a status
// added to the enum but not to the table, or an edge into a state nothing can
// leave, fails here rather than at three in the morning inside a review cycle.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TASK_STATUS, TERMINAL, TRANSITIONS, allowedNext, assertTransition, canTransition } from '../src/transitions.mjs'
import { CODES } from '../src/errors.mjs'

const ALL = Object.values(TASK_STATUS)

test('the table covers exactly the declared statuses', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...ALL].sort())
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(ALL.includes(to), `${from} -> ${to} names a status that is not in TASK_STATUS`)
    }
  }
})

test('terminal states have no way out, and nothing else is a dead end', () => {
  for (const status of ALL) {
    if (TERMINAL.has(status)) {
      assert.deepEqual(TRANSITIONS[status], [], `${status} is terminal and must have no outgoing edge`)
    } else {
      assert.ok(TRANSITIONS[status].length > 0, `${status} has no way out — a task there is stuck forever`)
    }
  }
})

test('every status except created is reachable', () => {
  const reachable = new Set()
  for (const tos of Object.values(TRANSITIONS)) for (const to of tos) reachable.add(to)
  for (const status of ALL) {
    if (status === TASK_STATUS.CREATED) continue
    assert.ok(reachable.has(status), `nothing can reach ${status}`)
  }
})

test('every non-terminal status can reach a terminal one', () => {
  const seen = new Map()
  const reachesTerminal = (status, trail = new Set()) => {
    if (TERMINAL.has(status)) return true
    if (seen.has(status)) return seen.get(status)
    if (trail.has(status)) return false
    trail.add(status)
    const ok = TRANSITIONS[status].some((next) => reachesTerminal(next, trail))
    seen.set(status, ok)
    return ok
  }
  for (const status of ALL) {
    assert.ok(reachesTerminal(status), `${status} can never reach completed or cancelled`)
  }
})

test('cancelled is reachable from every non-terminal status', () => {
  // The escape hatch has to be everywhere, or a wedged task needs a file edit.
  for (const status of ALL) {
    if (TERMINAL.has(status)) continue
    assert.ok(canTransition(status, TASK_STATUS.CANCELLED), `${status} cannot be cancelled`)
  }
})

const task = (over = {}) => ({ id: 'tsk_a_000001', status: TASK_STATUS.CREATED, owner: 'claude', needs_review: true, ...over })

test('an illegal transition names what was allowed instead', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.CREATED }), TASK_STATUS.APPROVED)
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.ILLEGAL_TRANSITION)
  assert.match(error.message, /created -> approved/)
  assert.match(error.message, /From created it may go to: assigned, in_progress, waiting_for_user, blocked, cancelled/)
})

test('a terminal task cannot be moved at all', () => {
  for (const status of [TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED]) {
    let error = null
    try {
      assertTransition(task({ status }), TASK_STATUS.IN_PROGRESS)
    } catch (e) {
      error = e
    }
    assert.equal(error.code, CODES.ILLEGAL_TRANSITION)
    assert.match(error.message, /terminal states have no way out/)
  }
})

test('a task that needs review cannot jump straight to completed', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.IN_PROGRESS, needs_review: true }), TASK_STATUS.COMPLETED)
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /needs a review/)

  // ...and one that does not, can.
  assert.equal(
    assertTransition(task({ status: TASK_STATUS.IN_PROGRESS, needs_review: false }), TASK_STATUS.COMPLETED),
    TASK_STATUS.COMPLETED
  )
})

test('a pending owner approval blocks completion', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.APPROVED, needs_review: true }), TASK_STATUS.COMPLETED, {
      pendingApproval: 'apr_x_000001'
    })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /apr_x_000001/)
})

test('a task cannot be approved by its own owner', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.REVIEW, owner: 'claude' }), TASK_STATUS.APPROVED, {
      review: { reviewer: 'claude', findings: [] }
    })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /not an independent review/)

  assert.equal(
    assertTransition(task({ status: TASK_STATUS.REVIEW, owner: 'claude' }), TASK_STATUS.APPROVED, {
      review: { reviewer: 'codex', findings: [] }
    }),
    TASK_STATUS.APPROVED
  )
})

test('approved requires an actual review record, not an assertion', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.REVIEW }), TASK_STATUS.APPROVED, {})
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /by a submitted review/)
})

test('changes_requested with no findings is refused', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.REVIEW }), TASK_STATUS.CHANGES_REQUESTED, {
      review: { reviewer: 'codex', findings: [] }
    })
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /tells the owner nothing/)
})

test('blocking without a reason is refused', () => {
  let error = null
  try {
    assertTransition(task({ status: TASK_STATUS.IN_PROGRESS }), TASK_STATUS.BLOCKED, {})
  } catch (e) {
    error = e
  }
  assert.equal(error.code, CODES.GUARD_FAILED)
  assert.match(error.message, /requires a reason/)
})

test('the review cycle can repeat', () => {
  // review -> changes_requested -> in_progress -> review -> approved -> completed
  const chain = [
    [TASK_STATUS.REVIEW, TASK_STATUS.CHANGES_REQUESTED],
    [TASK_STATUS.CHANGES_REQUESTED, TASK_STATUS.IN_PROGRESS],
    [TASK_STATUS.IN_PROGRESS, TASK_STATUS.REVIEW],
    [TASK_STATUS.REVIEW, TASK_STATUS.APPROVED],
    [TASK_STATUS.APPROVED, TASK_STATUS.COMPLETED]
  ]
  for (const [from, to] of chain) assert.ok(canTransition(from, to), `${from} -> ${to} must be possible`)
})

test('allowedNext is what an agent is told it may do', () => {
  assert.deepEqual(allowedNext({ status: TASK_STATUS.REVIEW }), ['approved', 'changes_requested', 'blocked', 'cancelled'])
})
