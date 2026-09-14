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
import * as registryModule from '../src/registry.mjs'

const { guardPolicy, loadRegistryConfig, validatePolicy } = registryModule
// Added in the phase-2 follow-up; looked up lazily so the older tests in this
// file still load against code that predates it.
const loweringRules = (...args) => registryModule.loweringRules(...args)
import { CODES } from '../src/errors.mjs'

// The built-in table — the floor every project inherits.
const policy = loadRegistryConfig().policy
const copy = () => JSON.parse(JSON.stringify(policy))

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

// ── the guard on a replacement policy ─────────────────────────────────────
//
// A project may replace policy.json (whole file), and may only make it stricter.

const guarded = (mutate) => {
  const next = copy()
  mutate(next)
  return guardPolicy(policy, next)
}

test('guard: the built-in table itself, and a copy with a stricter added rule, pass', () => {
  assert.deepEqual(validatePolicy(policy), [])
  assert.deepEqual(guardPolicy(policy, copy()), [])
  assert.deepEqual(
    guarded((p) => {
      p.rules.push({ id: 'prod-hosts', class: 'PRODUCTION', pattern: 'example\\.com', reason: 'our production host' })
      p.classes.COMPLIANCE = { severity: 6, summary: 'Regulated data.' }
      p.defaults.approval.COMPLIANCE = 'mandatory'
      p.rules.find((r) => r.id === 'outbound').class = 'SECURITY_SENSITIVE'
    }),
    []
  )
})

test('guard: dropping a built-in rule is refused', () => {
  const problems = guarded((p) => {
    p.rules = p.rules.filter((r) => r.id !== 'money')
  })
  assert.ok(problems.some((m) => /built-in rule "money" is missing/.test(m)), problems.join('\n'))
})

test('guard: re-classing a built-in rule to a weaker class is refused', () => {
  const problems = guarded((p) => {
    p.rules.find((r) => r.id === 'destructive').class = 'SAFE_WRITE'
  })
  assert.ok(problems.some((m) => /rule "destructive" is classed "SAFE_WRITE", weaker than the built-in "DESTRUCTIVE"/.test(m)), problems.join('\n'))
})

test('guard: hollowing out a built-in rule by changing its pattern, or dropping never_standing, is refused', () => {
  const problems = guarded((p) => {
    const money = p.rules.find((r) => r.id === 'money')
    money.pattern = '^$'
    delete money.never_standing
  })
  assert.ok(problems.some((m) => /rule "money" changes the built-in pattern/.test(m)))
  assert.ok(problems.some((m) => /rule "money" drops never_standing/.test(m)))
})

test('guard: a weaker unmatched_class is refused', () => {
  const problems = guarded((p) => {
    p.defaults.unmatched_class = 'EXTERNAL_SIDE_EFFECT'
  })
  assert.ok(problems.some((m) => /unmatched_class "EXTERNAL_SIDE_EFFECT" is weaker than the built-in "SECURITY_SENSITIVE"/.test(m)), problems.join('\n'))
})

test('guard: a class whose approval stops being mandatory is refused', () => {
  const problems = guarded((p) => {
    p.defaults.approval.EXTERNAL_SIDE_EFFECT = 'never'
  })
  assert.ok(problems.some((m) => /class "EXTERNAL_SIDE_EFFECT" must keep approval "mandatory"/.test(m)), problems.join('\n'))
})

test('guard: removing a class, lowering its severity, or stretching the approval lifetime is refused', () => {
  const removed = guarded((p) => {
    delete p.classes.DESTRUCTIVE
    delete p.defaults.approval.DESTRUCTIVE
  })
  assert.ok(removed.some((m) => /built-in class "DESTRUCTIVE" is missing/.test(m)))

  const lowered = guarded((p) => {
    p.classes.FINANCIAL.severity = 2
  })
  assert.ok(lowered.some((m) => /class "FINANCIAL" has severity 2, below the built-in 5/.test(m)))

  const longer = guarded((p) => {
    p.defaults.approval_ttl_seconds = 30 * 86400
  })
  assert.ok(longer.some((m) => /approval_ttl_seconds/.test(m)))
})

test('validatePolicy: a class that needs no approval may not rank at or above one that does', () => {
  // Under max-severity evaluation a SAFE_WRITE ranked 9 would win over FINANCIAL
  // for "edit the billing page and buy the plan", and nobody would be asked.
  const p = copy()
  p.classes.SAFE_WRITE.severity = 9
  assert.equal(classifyAction(p, 'edit the checkout and buy the paid plan').requires_approval, false, 'the hazard is real')
  assert.ok(validatePolicy(p).some((m) => /"SAFE_WRITE" needs no approval but has severity 9/.test(m)))
})

test('the kubectl case: a project rule cannot lower an action below the built-in default', () => {
  const unmatched = 'kubectl get pods -n payments'
  const overlapping = 'kubectl delete the media bucket'

  // Built in: nothing recognises kubectl, so it falls to the unmatched class and
  // needs the owner; a destructive phrasing is DESTRUCTIVE.
  assert.equal(classifyAction(policy, unmatched).action_class, 'SECURITY_SENSITIVE')
  assert.equal(classifyAction(policy, unmatched).requires_approval, true)
  assert.equal(classifyAction(policy, overlapping).action_class, 'DESTRUCTIVE')

  // The hazard the guard exists for, shown rather than asserted: once any rule
  // matches, the strongest match wins even when it is weaker than the default.
  const weakened = copy()
  weakened.rules.push({ id: 'kubectl', class: 'READ_ONLY', pattern: '\\bkubectl\\b', reason: 'cluster reads are harmless' })
  assert.equal(classifyAction(weakened, unmatched).action_class, 'READ_ONLY')
  assert.equal(classifyAction(weakened, unmatched).requires_approval, false, 'without the guard the owner is no longer asked')
  // Where it overlaps a built-in match, max-severity already keeps the built-in class.
  assert.equal(classifyAction(weakened, overlapping).action_class, 'DESTRUCTIVE')

  // The guard refuses the rule outright — including a still-mandatory class
  // that ranks below the built-in unmatched class.
  assert.ok(guardPolicy(policy, weakened).some((m) => /added rule "kubectl" is classed "READ_ONLY"/.test(m)))
  const sideways = copy()
  sideways.rules.push({ id: 'kubectl', class: 'EXTERNAL_SIDE_EFFECT', pattern: '\\bkubectl\\b', reason: 'talks to the cluster' })
  assert.ok(guardPolicy(policy, sideways).some((m) => /added rule "kubectl"/.test(m)))
  assert.deepEqual(validatePolicy(weakened), [], 'the table is self-consistent; only the guard can see the weakening')
})

// ── G. lowering the default is an explicit, justified opt-in ──────────────

const DEV_HOST = {
  id: 'dev-host',
  class: 'SAFE_WRITE',
  pattern: 'dev\\.aweiro\\.com|localhost|127\\.0\\.0\\.1',
  reason: 'The dev backend is where agents are meant to work.'
}

test('G: a lowering rule needs lowers_default: true AND a non-empty justification', () => {
  const bare = guarded((p) => p.rules.push({ ...DEV_HOST }))
  assert.ok(bare.some((m) => /added rule "dev-host"/.test(m) && /lowers_default/.test(m)), bare.join('\n'))

  const unjustified = guarded((p) => p.rules.push({ ...DEV_HOST, lowers_default: true, justification: '  ' }))
  assert.ok(unjustified.some((m) => /dev-host.*justification/.test(m)), unjustified.join('\n'))

  const flaggedString = guarded((p) => p.rules.push({ ...DEV_HOST, lowers_default: 'yes', justification: 'because' }))
  assert.ok(flaggedString.some((m) => /dev-host/.test(m)), 'only the literal true opts in')

  assert.deepEqual(guarded((p) => p.rules.push({ ...DEV_HOST, lowers_default: true, justification: 'local hosts are not production' })), [])
})

test('G: an accepted lowering rule lowers only the text it matches', () => {
  const p = copy()
  p.rules.push({ ...DEV_HOST, lowers_default: true, justification: 'local hosts are not production' })
  assert.deepEqual(guardPolicy(policy, p), [])

  assert.equal(classifyAction(p, 'curl localhost:3000/health').action_class, 'SAFE_WRITE')
  assert.equal(classifyAction(p, 'curl localhost:3000/health').requires_approval, false)
  assert.equal(classifyAction(p, 'kubectl get pods').action_class, 'SECURITY_SENSITIVE', 'unmatched text keeps the default')
  assert.equal(classifyAction(p, 'deploy the backend to localhost').action_class, 'PRODUCTION', 'a stronger match still wins')
  assert.equal(classifyAction(p, 'rotate the token on localhost').requires_approval, true)
})

test('G: lowers_default on a built-in rule, class or default changes nothing', () => {
  const reclassed = guarded((p) => {
    Object.assign(p.rules.find((r) => r.id === 'destructive'), { class: 'SAFE_WRITE', lowers_default: true, justification: 'trust me' })
  })
  assert.ok(reclassed.some((m) => /rule "destructive" is classed "SAFE_WRITE", weaker/.test(m)))

  const repatterned = guarded((p) => {
    Object.assign(p.rules.find((r) => r.id === 'money'), { pattern: '^$', lowers_default: true, justification: 'trust me' })
  })
  assert.ok(repatterned.some((m) => /rule "money" changes the built-in pattern/.test(m)))

  const unmatched = guarded((p) => {
    p.defaults.unmatched_class = 'SAFE_WRITE'
    p.defaults.lowers_default = true
    p.defaults.justification = 'trust me'
  })
  assert.ok(unmatched.some((m) => /unmatched_class "SAFE_WRITE" is weaker/.test(m)))

  // A flag on an unchanged built-in rule is inert: same verdicts, nothing listed.
  const inert = copy()
  Object.assign(inert.rules.find((r) => r.id === 'read'), { lowers_default: true, justification: 'noise' })
  assert.deepEqual(guardPolicy(policy, inert), [])
  for (const action of ['read the docs', 'frobnicate', 'buy a plan']) {
    assert.deepEqual(classifyAction(inert, action).action_class, classifyAction(policy, action).action_class)
  }
  assert.deepEqual(loweringRules(policy, inert), [])
})

// ── the table speaks Russian too ───────────────────────────────────────────

test('Russian phrasing classifies, and the dangerous side is covered wider than the safe one', () => {
  // Why this exists: the table was English-only, so a Russian action matched
  // nothing, fell to the unmatched class (SECURITY_SENSITIVE) and its task could
  // not be claimed AT ALL. On 2026-09-13 three tasks in the Tripix journal were
  // stuck exactly there, one of them holding seven files with no owner.
  for (const [action, expected] of [
    ['Заменить закон подъёма карты на следование за краем шторки', 'SAFE_WRITE'],
    ['Починить дрожание иконок в секции комментариев', 'SAFE_WRITE'],
    ['Написать тест на группировку фото-пинов', 'SAFE_WRITE'],
    ['Изучить, как устроен слой, и сделать сводку', 'READ_ONLY']
  ]) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, expected, action)
    assert.equal(verdict.requires_approval, false, `"${action}" must not need the owner`)
  }

  // THE HOLE THIS ORDERING PREVENTS. Max severity picks only among rules that
  // MATCHED, so covering SAFE_WRITE in Russian while a dangerous rule stays
  // English-only would let a safe verb carry a dangerous object straight past
  // the owner. Every line below is that shape.
  for (const [action, expected] of [
    ['Правка миграции: удалить колонку user_id', 'DESTRUCTIVE'],
    ['Исправить деплой-скрипт и выкатить на прод', 'PRODUCTION'],
    ['Рефакторинг модуля оплаты: купить тестовый доступ', 'FINANCIAL'],
    ['Проверить, как ротация ключа доступа ломает сессию', 'SECURITY_SENSITIVE'],
    ['Посмотреть логи и стереть базу разработки', 'DESTRUCTIVE'],
    ['Запушить ветку и открыть пулл-реквест', 'EXTERNAL_SIDE_EFFECT']
  ]) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, expected, action)
    assert.equal(verdict.requires_approval, true, `"${action}" must stop and wait for the owner`)
  }

  // Still fails closed: a Russian phrase the table does not recognise asks.
  assert.equal(classifyAction(policy, 'Выход из вертолётика на альбомном детенте').requires_approval, true)
})

// ── real corpus from the Tripix .collab/tasks journal ─────────────────────
//
// On 2026-09-13 three ordinary tasks fell to SECURITY_SENSICE with
// `matched: []` because their exact phrasing sat outside the table's
// vocabulary: "Перенести файлы камеры…" (move), "Добавить … зонд
// расхождения…" (add + probe), and the English "Add … an env kill switch"
// (bare "add" with no object from the old enumerated list). Each is a real
// action string copied from a task file, not a paraphrase, so this test
// breaks the moment a future edit narrows the table back down to the gap.
test('real task actions from the .collab/tasks journal classify without asking, dangerous ones still ask', () => {
  const mustNotApprove = [
    ['read backend/mcp/registry.js and summarise it', 'READ_ONLY'],
    [
      'Edit the trip map coordinator so that while the sheet band glide runs, the helicopter circle is held and any short orbit/strip approach is deferred until the band lands; make the three behaviour switches default to on.',
      'SAFE_WRITE'
    ],
    [
      'Add a pure zoom-ceiling policy driven by strip speed and apply it in the trip map route scrub coordinator, with unit tests and an env kill switch.',
      'SAFE_WRITE'
    ],
    [
      'Implement a zoom-ceiling policy in the trip map route scrub coordinator and write a test for it. Edit Swift sources and unit tests in the working tree only.',
      'SAFE_WRITE'
    ],
    [
      'Add a pure spatial grouping rule for trip map photo pins: quality-ordered greedy seeding with a minimum separation radius, radius chosen from a fixed ladder by a pin-count ceiling, members snapped to their seed coordinate. Edit iOS client only.',
      'SAFE_WRITE'
    ],
    [
      'Заменить закон подъёма карты (по пинам, задержка 0.5 с + ход 1.5 с) на синхронное следование за нарисованным краем шторки: подъём = половина хода края, привод — display-link по presentation-слою пробника.',
      'SAFE_WRITE'
    ],
    [
      'Правка iOS: в releaseHelicopterOrbitIfNoLongerRequested не отдавать камеру autoFit, когда RouteScrub не engaged; мягкий выход (pitch/bearing→0 + зум по политике полосы) без смены центра.',
      'SAFE_WRITE'
    ],
    [
      'Edit Tripix/TripMap/Presentation/Core/TripMapView+CoordinatorHelicopterOrbit.swift to fix the camera pull-back when the helicopter toggle is switched off on the album detent; implement a soft exit that keeps the centre and straightens pitch and bearing.',
      'SAFE_WRITE'
    ],
    [
      'Read-only аудит кодовой базы: карта архитектуры, сквозные аспекты (camera choreography, playback session, caching, prefetch, ошибки, транспорт, route presentation и др.), кандидаты на модули, план миграции. Итог — документ docs/audit/ARCHITECTURE_CROSS_CUTTING_AUDIT.md. Код не меняется.',
      'READ_ONLY'
    ],
    [
      'Перенос объявлений без изменения поведения: EventTrackingPhase из Presentation/Detail в Domain/Policy; regionFitFlyScreenThreshold и playbackRestoreFlyScreenThreshold из TripMapView в TripMapCameraDirector; ImmersiveMapMediaCardMetrics из SwiftUI-файла в отдельный файл. Сборка iOS, preflight, независимая проверка.',
      'SAFE_WRITE'
    ],
    [
      'Добавить characterization-тесты синхронизации контроллер↔биндер↔reducer, чистый exhaustive-маппинг TripPulsePlaybackState↔TripPlaybackSessionLifecycle с тестом и зонд расхождения logDiagnostic по фронту в биндере. Пять мест записи намерения, syncLifecycle, shouldPause и reducer не менять.',
      'SAFE_WRITE'
    ],
    [
      'Перенести чистые файлы камеры из Tripix/TripMap/Presentation/Core в папку Tripix/TripMap/CameraCore без изменения кода и добавить проверку, что файлы этой папки не импортируют MapboxMaps и SwiftUI',
      'SAFE_WRITE'
    ],
    // the two examples that motivated this test
    ['Перенести файлы камеры в новую папку', 'SAFE_WRITE'],
    ['Add diagnostic logging to the binder', 'SAFE_WRITE']
  ]
  for (const [action, expected] of mustNotApprove) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, expected, action)
    assert.equal(verdict.requires_approval, false, `"${action}" is ordinary work and must not need the owner`)
  }

  // The broadened "write" rule (bare \badd\b, \bmove\b, "перенес", "добав", …)
  // must not swallow phrasing that is dangerous for an unrelated reason —
  // max-severity still has to pick the dangerous class over the safe one.
  const stillDangerous = [
    ['Добавить ключ API в конфиг деплоя', 'SECURITY_SENSITIVE'],
    ['Add the API key to the deploy config', 'PRODUCTION'],
    ['Перенести продакшн-базу на новый сервер', 'PRODUCTION'],
    ['Move the billing script and buy the paid tier', 'FINANCIAL']
  ]
  for (const [action, expected] of stillDangerous) {
    const verdict = classifyAction(policy, action)
    assert.equal(verdict.action_class, expected, action)
    assert.equal(verdict.requires_approval, true, `"${action}" must still stop and wait for the owner`)
  }
})
