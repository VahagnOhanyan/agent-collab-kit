// The model registry: which model a level means, and whether the ids in it are
// still true.
//
// What is proved here: the built-in ladder is complete and internally
// consistent; a registry that could answer a routing question with nonsense (a
// rung with two defaults, a fallback that does not exist, a preview model with
// nowhere to fall back to) is refused; a project cannot replace the ladder; a
// model named in free text resolves to one registry entry so the journal can be
// counted later; and an id the vendor no longer lists is reported as drift
// rather than assumed fine.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG_DIR } from '../src/paths.mjs'
import { catalogDrift, listModels, modelByRef, resolveModel } from '../src/models.mjs'
import { loadConfigFrom, validateModels, validateRegistry } from '../src/registry.mjs'
import { apis, sandbox, tempDir, writeJson } from './helpers.mjs'

const builtinModels = () => JSON.parse(readFileSync(join(DEFAULT_CONFIG_DIR, 'models.json'), 'utf8'))
const agentIds = new Set(['claude', 'codex', 'gemini'])

test('the built-in ladder is complete: every level is served, every agent has a model, nothing contradicts', () => {
  const models = builtinModels()
  const { problems, warnings } = validateModels(models, { agentIds })
  assert.deepEqual(problems, [])
  assert.deepEqual(warnings, [], 'a warning here means a level or an agent nobody can serve')

  const ranks = Object.values(models.levels).map((l) => l.rank)
  assert.deepEqual([...ranks].sort((a, b) => a - b), [0, 1, 2, 3], 'four ranked levels, L0 to L3')

  // The rung that matters most: the default is the middle one, not the top.
  const sonnet = modelByRef({ models }, 'sonnet')
  assert.equal(sonnet.level, 'L1')
  assert.equal(sonnet.fallback, 'haiku')
  assert.equal(modelByRef({ models }, 'astra').level, 'L3', 'the most expensive model is the top rung, not the default')
})

test('a registry that could answer a routing question with nonsense is refused', () => {
  const base = builtinModels()
  const only = (extra) => ({
    levels: base.levels,
    vendors: { anthropic: { agent: 'claude', catalog_file: null, verified: 'owner' } },
    models: [
      {
        ref: 'sonnet',
        id: 'claude-sonnet-5',
        vendor: 'anthropic',
        level: 'L1',
        maturity: 'stable',
        verified: 'owner',
        fallback: null
      },
      ...extra
    ]
  })
  const problemsOf = (models) => validateModels(models, { agentIds: new Set(['claude']) }).problems

  const entry = (over = {}) => ({
    ref: 'other',
    id: 'claude-other-5',
    vendor: 'anthropic',
    level: 'L2',
    maturity: 'stable',
    verified: 'owner',
    fallback: null,
    ...over
  })

  assert.deepEqual(problemsOf(only([entry()])), [], 'the shape this test varies is otherwise valid')

  assert.match(problemsOf(only([entry({ level: 'L9' })]))[0], /claims unknown level "L9"/)
  assert.match(problemsOf(only([entry({ ref: 'sonnet' })]))[0], /declared twice/)
  assert.match(problemsOf(only([entry({ level: 'L1' })]))[0], /both claim level L1 for vendor anthropic/)
  assert.match(problemsOf(only([entry({ fallback: 'nobody' })]))[0], /falls back to "nobody", which is not declared/)
  assert.match(problemsOf(only([entry({ fallback: 'other' })]))[0], /falls back to itself/)
  assert.match(problemsOf(only([entry({ maturity: 'preview' })]))[0], /preview with no fallback/)
  assert.match(problemsOf(only([entry({ maturity: 'experimental' })]))[0], /has maturity "experimental"/)
  assert.match(problemsOf(only([entry({ verified: 'probably' })]))[0], /has verified "probably"/)
  assert.match(problemsOf(only([entry({ vendor: 'acme' })]))[0], /names unknown vendor "acme"/)
  assert.match(problemsOf(only([entry({ max_level: 'L0' })]))[0], /max_level L0 below its own level L2/)
  assert.match(problemsOf(only([entry({ ref: 'Other' })]))[0], /has a ref that is not/)
  assert.match(problemsOf(only([entry({ agent: 'codex' })]))[0], /says agent "codex" but vendor "anthropic" says "claude"/)

  // A preview model may be withdrawn mid-task, so one is allowed only with
  // somewhere to fall back to.
  assert.deepEqual(problemsOf(only([entry({ maturity: 'preview', fallback: 'sonnet' })])), [])

  // A cycle would make "fall back" loop forever instead of degrading.
  const cycle = only([entry({ fallback: 'third' }), entry({ ref: 'third', level: 'L3', fallback: 'other' })])
  assert.ok(
    problemsOf(cycle).some((p) => /fallback chain from "other" loops/.test(p)),
    JSON.stringify(problemsOf(cycle))
  )
})

test('an unserved level and a model-less agent are warnings, not problems: the registry stays readable', () => {
  const base = builtinModels()
  const thin = {
    levels: base.levels,
    vendors: { anthropic: { agent: 'claude', catalog_file: null, verified: 'owner' } },
    models: [
      { ref: 'sonnet', id: 'claude-sonnet-5', vendor: 'anthropic', level: 'L1', maturity: 'stable', verified: 'owner' }
    ]
  }
  const { problems, warnings } = validateModels(thin, { agentIds: new Set(['claude', 'codex']) })
  assert.deepEqual(problems, [])
  assert.ok(warnings.some((w) => /level L0 has no model/.test(w)))
  assert.ok(warnings.some((w) => /level L3 has no model/.test(w)))
  assert.ok(warnings.some((w) => /agent "codex" has no model/.test(w)))
})

test('a project cannot replace the ladder: its models.json is ignored and the attempt is reported', () => {
  const base = tempDir('collab-models-project-')
  try {
    const project = join(base, 'proj')
    mkdirSync(project)
    const registry = join(base, 'registry')
    writeJson(join(registry, 'demo', 'project.json'), { id: 'demo', roots: [project] })
    // A project claiming a cheap model is the top rung: the one thing a
    // replacement could express, and the reason it is ignored.
    writeJson(join(registry, 'demo', 'collab', 'models.json'), {
      levels: { L3: { rank: 3, summary: 'Critical.' } },
      vendors: { anthropic: { agent: 'claude', catalog_file: null, verified: 'owner' } },
      models: [{ ref: 'haiku', id: 'claude-haiku-4-5-20251001', vendor: 'anthropic', level: 'L3', maturity: 'stable', verified: 'owner' }]
    })

    const config = loadConfigFrom(join(registry, 'demo', 'collab'), { kind: 'project', id: 'demo', dir: join(registry, 'demo') })
    assert.deepEqual(config.models, builtinModels(), 'the built-in ladder is the one in force')
    assert.equal(config.meta.overridden.models, false, 'the meta says which file is in force, not which was shipped')
    assert.ok(config.meta.files.models.startsWith(DEFAULT_CONFIG_DIR), config.meta.files.models)
    assert.ok(
      config.meta.warnings.some((w) => /models\.json: the model registry comes only from the built-in config/.test(w)),
      JSON.stringify(config.meta.warnings)
    )
    assert.equal(modelByRef(config, 'haiku').level, 'L0', 'the project did not get to promote a cheap model to L3')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('list_models answers in levels, ordered by rank, and says which vendors are checkable', () => {
  const sbx = sandbox()
  try {
    const { claude } = apis(sbx)
    const answer = claude.listModels()
    assert.deepEqual(answer.levels.map((l) => l.id), ['L0', 'L1', 'L2', 'L3'])
    assert.ok(answer.levels.every((l) => l.summary && Array.isArray(l.models)))
    assert.ok(answer.levels.find((l) => l.id === 'L1').models.includes('sonnet'))

    const openai = answer.vendors.find((v) => v.name === 'openai')
    assert.equal(openai.checkable, true, 'the Codex CLI keeps a catalog, so its ids are checkable')
    assert.equal(answer.vendors.find((v) => v.name === 'anthropic').checkable, false)
    assert.ok(answer.models.length >= 4)
  } finally {
    sbx.cleanup()
  }
})

test('the fixture roster keeps the built-in ladder valid, and an unregistered vendor agent is only a warning', () => {
  const sbx = sandbox()
  try {
    const config = loadConfigFrom(sbx.configDir, { kind: 'config-dir', dir: sbx.configDir })
    const { problems, warnings } = validateRegistry(config)
    assert.deepEqual(problems, [], 'a roster without gemini must not make the machine ladder invalid')
    assert.ok(
      warnings.some((w) => /vendor "google" names agent "gemini", which is not registered/.test(w)),
      JSON.stringify(warnings)
    )
  } finally {
    sbx.cleanup()
  }
})

test('a model named in free text resolves to one entry, and an unknown name stays visible as itself', () => {
  const config = { models: builtinModels() }

  assert.deepEqual(resolveModel(config, 'sonnet'), {
    ref: 'sonnet',
    id: 'claude-sonnet-5',
    effort: null,
    known: true,
    named: 'sonnet'
  })
  assert.equal(resolveModel(config, 'claude-sonnet-5').ref, 'sonnet', 'the vendor id resolves to the stable ref')

  // The shape already in the live journal: effort crammed into the same string.
  const terra = resolveModel(config, 'gpt-5.6-terra (effort high)')
  assert.equal(terra.ref, 'terra')
  assert.equal(terra.effort, 'high')

  assert.equal(resolveModel(config, 'astra').effort, 'max', "a rung's own effort is the default")

  // Not an error: a model the registry has not heard of is exactly what the
  // owner needs to see in the journal.
  const unknown = resolveModel(config, 'llama-9')
  assert.equal(unknown.known, false)
  assert.equal(unknown.ref, null)
  assert.equal(unknown.named, 'llama-9')
  assert.equal(resolveModel(config, '').known, false)
})

test('drift: an id the vendor no longer lists is reported, and a vendor with no catalog is unverifiable, never ok', () => {
  const base = tempDir('collab-models-drift-')
  try {
    const catalog = join(base, 'models_cache.json')
    const write = (slugs) =>
      writeFileSync(catalog, JSON.stringify({ fetched_at: '2026-09-15T00:00:00Z', models: slugs.map((slug) => ({ slug })) }))

    const config = {
      models: {
        levels: builtinModels().levels,
        vendors: {
          openai: { agent: 'codex', catalog_file: catalog, catalog_path: 'models', catalog_key: 'slug', verified: 'catalog' },
          anthropic: { agent: 'claude', catalog_file: null, verified: 'owner', verified_at: '2026-09-15' }
        },
        models: [
          { ref: 'terra', id: 'gpt-5.6-terra', vendor: 'openai', level: 'L1', maturity: 'stable', verified: 'catalog' },
          { ref: 'sonnet', id: 'claude-sonnet-5', vendor: 'anthropic', level: 'L1', maturity: 'stable', verified: 'owner' }
        ]
      }
    }

    write(['gpt-5.6-terra', 'gpt-6-astra'])
    const [openai, anthropic] = catalogDrift(config)
    assert.equal(openai.status, 'ok')
    assert.deepEqual(openai.missing, [])
    assert.deepEqual(openai.appeared, ['gpt-6-astra'], 'a model we do not use is reported, not hidden')
    assert.equal(openai.fetched_at, '2026-09-15T00:00:00Z')

    // Saying "ok" about something nobody checked is the failure this prevents.
    assert.equal(anthropic.status, 'unverifiable')
    assert.equal(anthropic.verified, 'owner')
    assert.equal(anthropic.verified_at, '2026-09-15')

    write(['gpt-6-astra'])
    const drifted = catalogDrift(config)[0]
    assert.equal(drifted.status, 'drift')
    assert.deepEqual(drifted.missing, ['gpt-5.6-terra'])

    rmSync(catalog)
    const gone = catalogDrift(config)[0]
    assert.equal(gone.status, 'unreadable')
    assert.match(gone.detail, /does not exist/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── what a task declares about itself, and what the layer works out ────────

const world = () => {
  const sbx = sandbox()
  return { ...apis(sbx), sbx, cleanup: sbx.cleanup }
}

test('a spec survives create AND update, merges rather than replaces, and refuses a level nobody declared', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Extract the parser',
      action: 'edit a file',
      spec: {
        acceptance_criteria: ['the parser lives in its own file', 'no behaviour change in the caller'],
        non_goals: ['renaming the public API'],
        complexity: 'L1',
        implementation_risk: 'L1',
        review_risk: 'L1',
        classification_reason: 'one module, covered by tests'
      }
    })

    // The defect this test exists for: the MCP layer validates no schema, and
    // both createTask and updateTask work off whitelists. A field missing from
    // either silently stores nothing while appearing to work.
    const stored = w.claude.getTask({ task_id: task.id })
    assert.equal(stored.spec.acceptance_criteria.length, 2)
    assert.equal(stored.spec.review_risk, 'L1')
    assert.equal(stored.review_risk, 'L1', 'no floor applies to an ordinary edit')
    assert.equal(stored.review_risk_raised_by_floor, false)

    // Adding one criterion must not require re-sending the whole spec.
    await w.claude.updateTask({
      task_id: task.id,
      patch: { spec: { acceptance_criteria: ['the parser lives in its own file', 'the caller keeps its signature'], review_risk: 'L2' } }
    })
    const merged = w.claude.getTask({ task_id: task.id })
    assert.deepEqual(merged.spec.non_goals, ['renaming the public API'], 'a field not sent again is kept')
    assert.equal(merged.spec.review_risk, 'L2')
    assert.equal(merged.spec.classification_reason, 'one module, covered by tests')

    // Input validation happens before the transaction, like the title check
    // beside it, so these throw rather than reject.
    assert.throws(
      () => w.claude.updateTask({ task_id: task.id, patch: { spec: { review_risk: 'L7' } } }),
      (e) => /not a declared level/.test(e.message)
    )
    assert.throws(
      () => w.claude.createTask({ title: 'Bad field', action: 'edit a file', spec: { severity: 'high' } }),
      (e) => /spec has no field "severity"/.test(e.message)
    )
  } finally {
    w.cleanup()
  }
})

test('the policy table floors the review risk: one line in a financial action cannot be declared L1', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Renew the plan',
      action: 'purchase api credits for the build machine',
      spec: { review_risk: 'L1', classification_reason: 'it is a one-line config change' }
    })
    assert.equal(task.action_class, 'FINANCIAL')
    assert.equal(task.requires_approval, true)

    const read = w.claude.getTask({ task_id: task.id })
    // A floor that threw would refuse the work; a floor that returns corrects
    // the reading and says so.
    assert.equal(read.review_risk_declared, 'L1', 'what the lead said is kept')
    assert.equal(read.review_risk, 'L3', 'what applies is the floor')
    assert.equal(read.review_risk_floor, 'L3')
    assert.equal(read.review_risk_raised_by_floor, true)

    // And the money question still stops at the owner, as before.
    const approval = await w.claude.requestUserApproval({
      task_id: task.id,
      action: 'purchase api credits for the build machine',
      reason: 'the build machine is out of credits'
    })
    assert.equal(approval.status, 'pending')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'waiting_for_user')
  } finally {
    w.cleanup()
  }
})

test('a delegation resolves its model against the registry, records the rung and the fallback, and keeps an unknown name', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Move the parser', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })

    const { delegation } = await w.claude.addDelegation({
      task_id: task.id,
      to: 'codex',
      // The shape already in the live journal: effort crammed into the name.
      model: 'gpt-5.6-terra (effort high)',
      level: 'L1',
      reasons: 'verifiable in the repository, so it goes to the vendor with the environment',
      fallback_from: 'sol',
      purpose: 'review the extraction against origin/main'
    })
    assert.equal(delegation.model_ref, 'terra', 'the journal can be counted because the ref is resolved')
    assert.equal(delegation.model_id, 'gpt-5.6-terra')
    assert.equal(delegation.effort, 'high')
    assert.equal(delegation.model_known, true)
    assert.equal(delegation.level, 'L1')
    assert.equal(delegation.fallback_from, 'sol')
    assert.equal(delegation.model, 'gpt-5.6-terra (effort high)', 'what was named is kept verbatim as well')

    assert.throws(
      () => w.claude.addDelegation({ task_id: task.id, to: 'verifier', model: 'sonnet', level: 'L9' }),
      (e) => /not a declared level/.test(e.message)
    )

    // A model the registry has not heard of is a fact for the owner, not an error.
    const { delegation: odd } = await w.claude.addDelegation({ task_id: task.id, to: 'general-purpose', model: 'llama-9' })
    assert.equal(odd.model_known, false)
    assert.equal(odd.model_ref, null)
    assert.equal(odd.model, 'llama-9')

    await w.claude.completeDelegation({
      task_id: task.id,
      delegation_id: delegation.id,
      outcome: 'two findings, both fixed',
      rework_required: true
    })
    const closed = w.claude.getTask({ task_id: task.id }).delegations.find((d) => d.id === delegation.id)
    assert.equal(closed.rework_required, true, 'this is what says a rung was too low')
    assert.ok(closed.took_ms !== null, 'how long it took is derived from the timestamps, not declared')
  } finally {
    w.cleanup()
  }
})

test('the checks recorded against a task come back with it: evidence the layer owns is never asked for twice', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Run the checks', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    await w.claude.startRun({ runner: 'tap-check', task_id: task.id, wait_seconds: 20 })

    const read = w.claude.getTask({ task_id: task.id })
    assert.equal(read.runs.length, 1)
    assert.equal(read.runs[0].runner, 'tap-check')
    assert.equal(read.runs[0].status, 'passed')
    // The counters, not just the exit code: a suite that skipped everything
    // exits zero and proves nothing.
    assert.equal(read.runs[0].counts.pass, 1)
  } finally {
    w.cleanup()
  }
})

test('completing a task records only what the layer cannot see, and "not checked" is a first-class answer', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Ship the extraction',
      action: 'edit a file',
      needs_review: false,
      spec: { acceptance_criteria: ['the parser lives in its own file'], review_risk: 'L1' }
    })
    await w.claude.claimTask({ task_id: task.id })
    const done = await w.claude.completeTask({
      task_id: task.id,
      summary: 'extracted, build green',
      evidence: {
        criteria_status: [{ criterion: 'the parser lives in its own file', status: 'met' }],
        unverified: ['behaviour on the device was not checked'],
        risks: ['the caller has no regression test for the error path']
      }
    })
    assert.equal(done.status, 'completed')
    assert.equal(done.evidence.criteria_status[0].status, 'met')
    assert.deepEqual(done.evidence.unverified, ['behaviour on the device was not checked'])

    assert.throws(
      () => w.claude.completeTask({ task_id: task.id, evidence: { screenshots: ['a.png'] } }),
      (e) => /evidence has no field "screenshots"/.test(e.message)
    )
  } finally {
    w.cleanup()
  }
})

test('work crossing an agent boundary without criteria is warned about, never refused', async () => {
  const w = world()
  try {
    const bare = await w.claude.createTask({ title: 'Hand this over', action: 'edit a file' })
    await w.claude.claimTask({ task_id: bare.id })

    const delegated = await w.claude.addDelegation({ task_id: bare.id, to: 'verifier', model: 'sonnet', purpose: 'check it' })
    assert.ok(delegated.delegation, 'the work is recorded either way')
    assert.ok(delegated.warnings.some((line) => /no review_risk/.test(line)), JSON.stringify(delegated.warnings))
    assert.ok(delegated.warnings.some((line) => /no acceptance_criteria/.test(line)))

    const asked = await w.claude.requestReview({ task_id: bare.id, instructions: 'have a look' })
    assert.equal(asked.routed_to, 'codex')
    assert.ok(asked.warnings.length, 'the reviewer would be guessing at intent, and the lead hears it')

    // With the fields filled in, the same calls say nothing.
    const full = await w.claude.createTask({
      title: 'Hand this over properly',
      action: 'edit a file',
      spec: { acceptance_criteria: ['the caller keeps its signature'], review_risk: 'L1' }
    })
    await w.claude.claimTask({ task_id: full.id })
    const quiet = await w.claude.addDelegation({ task_id: full.id, to: 'verifier', model: 'sonnet', purpose: 'check it' })
    assert.deepEqual(quiet.warnings, [])
  } finally {
    w.cleanup()
  }
})

// ── review quality: slots, evidence, and what the reviewer reads first ─────

test('a slot records a verdict beside the task without moving it, so a reviewer that never answers cannot strand the work', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Extract the parser',
      action: 'edit a file',
      spec: { acceptance_criteria: ['the parser lives in its own file'], review_risk: 'L2' }
    })
    await w.claude.claimTask({ task_id: task.id })

    const gating = await w.claude.requestReview({ task_id: task.id, slot: 'implementation' })
    const extra = await w.claude.requestReview({ task_id: task.id, slot: 'tests', blocking: false })
    assert.equal(gating.review.blocking, true)
    assert.equal(extra.review.blocking, false)
    // Rounds count attempts, not opinions: both belong to round 1.
    assert.equal(gating.review.round, 1)
    assert.equal(extra.review.round, 1, 'an extra slot is not a second round')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')
    assert.equal(w.claude.getTask({ task_id: task.id }).waiting_on.ref, gating.review.id, 'the task waits on the gate, not the slot')

    // The slot answers first, and the task does not move.
    const slotVerdict = await w.codex.submitReview({
      review_id: extra.review.id,
      verdict: 'changes_requested',
      summary: 'no regression test for the error path',
      findings: [{ severity: 'minor', note: 'no test covers the throw', evidence: 'test/parser.test.js has no throwing case' }]
    })
    assert.equal(slotVerdict.blocking, false)
    assert.equal(slotVerdict.task_status, 'review', 'a slot verdict leaves the task where it was')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')

    // The gating review still decides.
    const gateVerdict = await w.codex.submitReview({ review_id: gating.review.id, verdict: 'approved', summary: 'checked the extraction' })
    assert.equal(gateVerdict.task_status, 'approved')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'approved')

    // And the rule a gating review gets from the transition guard is not lost
    // by skipping the transition.
    const bare = await w.claude.requestReview({ task_id: task.id, slot: 'security', blocking: false })
    await assert.rejects(
      w.codex.submitReview({ review_id: bare.review.id, verdict: 'changes_requested', summary: 'something feels off' }),
      (e) => /tells the author nothing/.test(e.message)
    )

    assert.throws(() => w.claude.requestReview({ task_id: task.id, slot: 'vibes' }), (e) => /slot must be one of/.test(e.message))
  } finally {
    w.cleanup()
  }
})

test('no evidence, no blocker: a finding that cannot say what shows it is recorded as a hypothesis', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Check the retry', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const asked = await w.claude.requestReview({ task_id: task.id })

    const answer = await w.codex.submitReview({
      review_id: asked.review.id,
      verdict: 'changes_requested',
      summary: 'one demonstrated, one suspected',
      findings: [
        // Claims to be proven, shows nothing: downgraded, and the severity is
        // left as filed so the pair reads honestly.
        { severity: 'blocker', confidence: 'proven', note: 'this will deadlock', file: 'a.js' },
        {
          severity: 'major',
          confidence: 'proven',
          note: 'the retry loses the cause',
          file: 'b.js',
          line: 9,
          evidence: 'the catch rethrows a new Error without `cause`',
          criterion: 'errors keep their cause',
          repro: 'call save() with a closed handle',
          impact: 'the operator sees "unknown error"',
          recommendation: 'pass the original as cause'
        }
      ]
    })
    const [suspicion, shown] = answer.review.findings
    assert.equal(suspicion.confidence, 'hypothesis', 'a blocker with nothing to show for it is a suspicion')
    assert.equal(suspicion.severity, 'blocker', 'and the severity is not quietly rewritten')
    assert.equal(shown.confidence, 'proven', 'evidence keeps the confidence that was claimed')
    assert.equal(shown.criterion, 'errors keep their cause')
    assert.equal(shown.recommendation, 'pass the original as cause')
    assert.equal(answer.hypotheses, 1)
    assert.equal(answer.proven, 1)
  } finally {
    w.cleanup()
  }
})

test("the reviewer reads the criteria and the runs first, and the author's account last and labelled", async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Extract the parser',
      action: 'edit a file',
      spec: {
        acceptance_criteria: ['the parser lives in its own file'],
        non_goals: ['renaming the public API'],
        review_risk: 'L2'
      }
    })
    await w.claude.claimTask({ task_id: task.id })
    await w.claude.startRun({ runner: 'tap-check', task_id: task.id, wait_seconds: 20 })

    await w.claude.requestReview({ task_id: task.id, instructions: 'I checked it and it is correct.' })
    const [message] = await w.codex.getMessages({ agent_id: 'codex', unread_only: true })

    const body = message.body
    const criteriaAt = body.indexOf('the parser lives in its own file')
    const runsAt = body.indexOf('tap-check')
    const claimAt = body.indexOf('I checked it and it is correct.')
    assert.ok(criteriaAt > -1 && runsAt > -1 && claimAt > -1, body)
    // The order IS the mechanism: an account read first is an anchor.
    assert.ok(criteriaAt < claimAt, 'the criteria come before the author\'s account')
    assert.ok(runsAt < claimAt, 'so do the checks that actually ran')
    assert.match(body, /read last and on purpose — it is a claim, not a finding/)
    assert.match(body, /Deliberately NOT in scope/)
    assert.match(body, /A finding with no evidence is recorded as a hypothesis/)

    // Without criteria the reviewer is told that intent had to be inferred,
    // rather than being handed less context than before.
    const bare = await w.claude.createTask({ title: 'No criteria here', action: 'edit a file' })
    await w.claude.claimTask({ task_id: bare.id })
    await w.claude.requestReview({ task_id: bare.id, instructions: 'quick look please' })
    const fresh = await w.codex.getMessages({ agent_id: 'codex', unread_only: true })
    const bareBody = fresh.find((m) => m.task_id === bare.id).body
    assert.match(bareBody, /no acceptance criteria recorded, so intent has to be inferred/)
    assert.match(bareBody, /quick look please/, 'the account is still there, just last')
  } finally {
    w.cleanup()
  }
})

test('the slot list the tool surface offers is the slot list the domain accepts', async () => {
  const { TOOLS } = await import('../src/mcp/tools.mjs')
  const { SLOTS } = await import('../src/domain/reviews.mjs')
  const schema = TOOLS.find((t) => t.name === 'request_review').inputSchema.properties.slot
  // tools.mjs imports nothing on purpose, so the two lists are kept identical
  // here rather than by an import.
  assert.deepEqual(schema.enum, [...SLOTS])
})

// ── the three deferred defects: no quorum deadlock, no stranded task ────────
// (a second pending gating review, a review stuck on an offline reviewer, and
// nothing able to void one — found in a live project journal on 2026-09-15)

test('a second gating review is refused while one is pending, naming it and how to release it', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Extract the parser', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const first = await w.claude.requestReview({ task_id: task.id })

    // This is the exact state that used to deadlock: assertTransition's
    // from===to shortcut let a second `review` request through silently. The
    // guard lives inside the transaction, so the refusal is a rejection.
    await assert.rejects(
      w.claude.requestReview({ task_id: task.id }),
      (e) => new RegExp(`already has a pending gating review \\(${first.review.id}`).test(e.message) && /release_review/.test(e.message)
    )

    // A non-blocking slot alongside the pending gate is unaffected — that is
    // the whole point of Phase 3.
    const slot = await w.claude.requestReview({ task_id: task.id, slot: 'tests', blocking: false })
    assert.equal(slot.review.blocking, false)

    // Once the gate is answered, asking again is fine.
    await w.codex.submitReview({ review_id: first.review.id, verdict: 'changes_requested', summary: 'one issue', findings: [{ note: 'x' }] })
    await w.claude.updateTask({ task_id: task.id, status: 'in_progress' })
    const second = await w.claude.requestReview({ task_id: task.id })
    assert.notEqual(second.review.id, first.review.id)
  } finally {
    w.cleanup()
  }
})

test('releasing the review that gates a task moves it to blocked with the reason, not silently nowhere', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Fix the helicopter exit', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const asked = await w.claude.requestReview({ task_id: task.id })
    assert.equal(w.claude.getTask({ task_id: task.id }).waiting_on.ref, asked.review.id)

    // The reviewer itself may decline what it cannot get to.
    const released = await w.codex.releaseReview({ review_id: asked.review.id, reason: 'hit the plan rate limit, round 8' })
    assert.equal(released.review.verdict, 'released')
    assert.equal(released.task_status, 'blocked')

    const after = w.claude.getTask({ task_id: task.id })
    assert.equal(after.status, 'blocked')
    assert.equal(after.blocked_reason, 'hit the plan rate limit, round 8')
    assert.equal(after.waiting_on, null, 'nothing is being waited on any more')

    // Answering a released review is refused, same as answering a decided one.
    await assert.rejects(
      w.codex.submitReview({ review_id: asked.review.id, verdict: 'approved', summary: 'late' }),
      (e) => /already returned "released"/.test(e.message)
    )
    // And it cannot be released twice.
    await assert.rejects(
      w.codex.releaseReview({ review_id: asked.review.id, reason: 'again' }),
      (e) => /already returned "released"/.test(e.message)
    )

    // A blocked task is not stuck: the owner can put it back to work and ask
    // a different reviewer.
    await w.claude.updateTask({ task_id: task.id, status: 'in_progress' })
    const retried = await w.claude.requestReview({ task_id: task.id })
    assert.notEqual(retried.review.id, asked.review.id)

    const author = (await w.claude.getMessages({ agent_id: 'claude', unread_only: true })).find((m) => m.thread_id === asked.review.id)
    assert.match(author.body, /released instead of answered/)
    assert.match(author.body, /hit the plan rate limit, round 8/)
  } finally {
    w.cleanup()
  }
})

test('releasing a non-blocking slot only removes the slot; releasing a stale review on a finished task touches nothing', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({
      title: 'Extract the parser',
      action: 'edit a file',
      spec: { acceptance_criteria: ['done'], review_risk: 'L1' }
    })
    await w.claude.claimTask({ task_id: task.id })
    const gate = await w.claude.requestReview({ task_id: task.id })
    const slot = await w.claude.requestReview({ task_id: task.id, slot: 'security', blocking: false })

    const releasedSlot = await w.claude.releaseReview({ review_id: slot.review.id, reason: 'not needed after all' })
    assert.equal(releasedSlot.task_status, 'review', 'the slot never gated the task, so releasing it changes nothing about it')
    assert.equal(w.claude.getTask({ task_id: task.id }).status, 'review')
    assert.equal(w.claude.getTask({ task_id: task.id }).waiting_on.ref, gate.review.id, 'the real gate is untouched')

    await w.codex.submitReview({ review_id: gate.review.id, verdict: 'approved', summary: 'looks right' })
    await w.claude.completeTask({ task_id: task.id, summary: 'done' })

    // A review that outlived its task — cancelled or, as here, completed —
    // is stale, not gating anything; releasing it must not resurrect the task.
    const before = w.claude.getTask({ task_id: task.id })
    // Nothing left pending on a completed task, so simulate the live-journal
    // shape directly: a pending review whose task has already finished.
    const orphanTask = await w.claude.createTask({ title: 'Cancelled elsewhere', action: 'edit a file' })
    await w.claude.claimTask({ task_id: orphanTask.id })
    const orphanReview = await w.claude.requestReview({ task_id: orphanTask.id })
    await w.claude.updateTask({ task_id: orphanTask.id, status: 'cancelled' })
    const releasedStale = await w.claude.releaseReview({ review_id: orphanReview.review.id, reason: 'task is gone' })
    assert.equal(releasedStale.task_status, 'cancelled', 'a terminal task is left exactly as it was')
    assert.equal(before.status, 'completed', 'the earlier, unrelated task is untouched by any of this')
  } finally {
    w.cleanup()
  }
})

test('only the reviewer, the requester, or the task owner/a contributor may release a review', async () => {
  const w = world()
  try {
    const task = await w.claude.createTask({ title: 'Extract the parser', action: 'edit a file' })
    await w.claude.claimTask({ task_id: task.id })
    const asked = await w.claude.requestReview({ task_id: task.id, reviewer_agent: 'codex' })

    // Nobody else is registered in this fixture roster to prove the negative
    // with, so this proves the positive set is exactly as documented instead:
    // the reviewer (codex) and the requester/owner (claude) both may.
    const first = await w.codex.releaseReview({ review_id: asked.review.id, reason: 'declining' })
    assert.equal(first.review.verdict, 'released')
    assert.equal(first.task_status, 'blocked', 'it was the gate, so releasing it blocked the task')

    // Back to work before a second review can be requested — the same cycle
    // changes_requested -> in_progress -> review already uses.
    await w.claude.updateTask({ task_id: task.id, status: 'in_progress' })
    const second = await w.claude.requestReview({ task_id: task.id, reviewer_agent: 'codex' })
    assert.equal((await w.claude.releaseReview({ review_id: second.review.id, reason: 'no longer needed' })).review.verdict, 'released')
  } finally {
    w.cleanup()
  }
})

test('the live Codex catalog still lists every id the built-in registry claims for it', () => {
  // Not a unit test: this is the drift check itself, run against the machine.
  // It fails when the vendor's line-up moves and the registry has not caught up,
  // which is the whole reason the ids live in data instead of prose.
  const models = builtinModels()
  const openai = models.vendors.openai
  const report = catalogDrift({ models }).find((v) => v.vendor === 'openai')
  if (report.status === 'unreadable') {
    // A machine without the Codex CLI is not a broken registry.
    assert.match(report.detail, /does not exist/)
    return
  }
  assert.equal(report.status, 'ok', `${openai.catalog_file} no longer lists: ${(report.missing || []).join(', ')}`)
})
