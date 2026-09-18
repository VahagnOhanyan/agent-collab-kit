// Phase-2 round 4: owner-only operations, and `collab reviews` for skills.
// Both tests were run against the code before the change and failed there.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CODES } from '../src/errors.mjs'
import { apis, runCli, sandbox } from './helpers.mjs'

test('R4-1: complete_task and request_review are refused for a caller who is neither owner nor contributor', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const reviewed = await claude.createTask({ title: 'Claude work', action: 'edit a file' })
    await claude.claimTask({ task_id: reviewed.id })
    await assert.rejects(codex.requestReview({ task_id: reviewed.id }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal(claude.getTask({ task_id: reviewed.id }).status, 'in_progress')

    const quick = await claude.createTask({ title: 'No review needed', action: 'edit a file', needs_review: false })
    await claude.claimTask({ task_id: quick.id })
    await assert.rejects(codex.completeTask({ task_id: quick.id, summary: 'done by someone else' }), (e) => e.code === CODES.NOT_PERMITTED)
    assert.equal(claude.getTask({ task_id: quick.id }).status, 'in_progress')

    // The owner works as before.
    const review = await claude.requestReview({ task_id: reviewed.id })
    assert.equal(review.routed_to, 'codex')
    await codex.submitReview({ review_id: review.review.id, verdict: 'approved', summary: 'Checked the one file it touches.' })
    assert.equal((await claude.completeTask({ task_id: reviewed.id })).status, 'completed')

    // A contributor who is no longer the owner works as before too.
    const shared = await claude.createTask({ title: 'Handed over', action: 'edit a file' })
    await claude.claimTask({ task_id: shared.id })
    await claude.releaseTask({ task_id: shared.id, reason: 'handing over' })
    await codex.claimTask({ task_id: shared.id })
    const handed = claude.getTask({ task_id: shared.id })
    assert.equal(handed.owner, 'codex')
    assert.ok(handed.contributors.includes('claude'))
    const byContributor = await claude.requestReview({ task_id: shared.id, reviewer_capability: 'review_code' })
    assert.ok(byContributor.routed_to)
  } finally {
    sbx.cleanup()
  }
})

test('R4-2: collab reviews --reviewer --pending --task --json lists reviews with their task title and status, read-only', async () => {
  const sbx = sandbox()
  const { claude, codex } = apis(sbx)
  try {
    const open = await claude.createTask({ title: 'Open review', action: 'edit a file' })
    await claude.claimTask({ task_id: open.id })
    const pending = await claude.requestReview({ task_id: open.id })

    const answered = await claude.createTask({ title: 'Answered review', action: 'edit a file' })
    await claude.claimTask({ task_id: answered.id })
    const done = await claude.requestReview({ task_id: answered.id })
    await codex.submitReview({ review_id: done.review.id, verdict: 'approved', summary: 'Read every changed line.' })

    const stale = await claude.createTask({ title: 'Abandoned review', action: 'edit a file' })
    await claude.claimTask({ task_id: stale.id })
    const orphan = await claude.requestReview({ task_id: stale.id })
    await claude.updateTask({ task_id: stale.id, status: 'cancelled' })

    const run = (args) => runCli(['reviews', ...args], { cwd: sbx.root, options: sbx.options })

    const waiting = run(['--reviewer', 'codex', '--pending', '--json'])
    assert.equal(waiting.status, 0, waiting.stderr)
    const list = JSON.parse(waiting.stdout)
    assert.deepEqual(list.map((r) => r.id).sort(), [pending.review.id, orphan.review.id].sort())
    const byId = Object.fromEntries(list.map((r) => [r.id, r]))
    assert.deepEqual(
      {
        task_id: byId[pending.review.id].task_id,
        round: byId[pending.review.id].round,
        verdict: byId[pending.review.id].verdict,
        status: byId[pending.review.id].status,
        author: byId[pending.review.id].author,
        reviewer: byId[pending.review.id].reviewer,
        task_title: byId[pending.review.id].task_title,
        task_status: byId[pending.review.id].task_status
      },
      { task_id: open.id, round: 1, verdict: 'pending', status: 'pending', author: 'claude', reviewer: 'codex', task_title: 'Open review', task_status: 'review' }
    )
    assert.match(byId[pending.review.id].created_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(byId[orphan.review.id].task_status, 'cancelled')
    assert.equal(byId[orphan.review.id].status, 'stale', 'a pending review on a finished task is recognisably stale')

    const oneTask = JSON.parse(run(['--task', answered.id, '--json']).stdout)
    assert.equal(oneTask.length, 1)
    assert.equal(oneTask[0].verdict, 'approved')
    assert.equal(oneTask[0].status, 'answered')

    assert.equal(JSON.parse(run(['--json']).stdout).length, 3)
    assert.deepEqual(JSON.parse(run(['--reviewer', 'claude', '--json']).stdout), [])

    // verifier's review-rounds check reads slot and finding strength from this JSON, not the text.
    const shaped = await claude.createTask({ title: 'Shaped review', action: 'edit a file' })
    await claude.claimTask({ task_id: shaped.id })
    const slotted = await claude.requestReview({ task_id: shaped.id, slot: 'implementation' })
    await codex.submitReview({
      review_id: slotted.review.id,
      verdict: 'changes_requested',
      summary: 'one proven, one guess',
      findings: [
        { severity: 'major', note: 'drops the draft', evidence: 'cli.mjs:1 — reproduced with a fixture' },
        { severity: 'minor', note: 'might be slow' }
      ]
    })
    const [row] = JSON.parse(run(['--task', shaped.id, '--json']).stdout)
    assert.equal(row.slot, 'implementation')
    assert.equal(row.blocking, true)
    assert.deepEqual(row.findings.map((f) => f.severity), ['major', 'minor'])
    assert.equal(row.findings[0].confidence === 'hypothesis', false, 'a finding with evidence is not a hypothesis')
    assert.equal(row.findings[1].confidence, 'hypothesis')
    assert.equal(JSON.stringify(row.findings).includes('drops the draft'), false, 'finding text stays out of the summary')

    const human = run(['--pending'])
    assert.equal(human.status, 0, human.stderr)
    assert.match(human.stdout, /Open review/)

    const before = claude.events({ limit: 1000 }).length
    run(['--reviewer', 'codex', '--pending', '--json'])
    assert.equal(claude.events({ limit: 1000 }).length, before, 'listing reviews writes nothing to the audit log')
  } finally {
    sbx.cleanup()
  }
})
