// agents/review-rounds.jq — эскалация «вопроса формы» после двух раундов ревью с настоящими находками.
// Вход — строки `collab reviews --task <id> --json`. Запуск: node --test tests/test_review_rounds.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// REVIEW_ROUNDS_FILTER — для негативного контроля: прогнать тесты на мутированной копии фильтра.
const FILTER = process.env.REVIEW_ROUNDS_FILTER ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'review-rounds.jq')

const at = m => new Date(Date.UTC(2026, 8, 18, 10, 0, 0) + m * 60000).toISOString()
let n = 0
const review = (round, verdict, { findings = [], slot = 'implementation', created = round * 100, submitted = round * 100 + 30 } = {}) => ({
  id: `rev_${++n}`, task_id: 'tsk_x', round, verdict, slot, blocking: slot === 'implementation',
  created_at: at(created), submitted_at: verdict === 'pending' ? null : at(submitted), findings
})
const proven = (severity = 'major') => ({ severity, confidence: 'proven' })
const guess = (severity = 'major') => ({ severity, confidence: 'hypothesis' })

function rounds (rows) {
  const r = spawnSync('jq', ['-f', FILTER], { input: JSON.stringify(rows), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('два настоящих раунда подряд, третий без эскалации — fail', () => {
  const out = rounds([review(1, 'changes_requested', { findings: [proven()] }), review(2, 'changes_requested', { findings: [proven('critical')] }), review(3, 'pending')])
  assert.equal(out.second_real_round, 2)
  assert.match(out.checks.escalation, /^fail: раунд 3/)
})

test('challenger отвечен до третьего раунда — ok', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(2, 'changes_requested', { findings: [proven()] }),
    review(2, 'approved', { slot: 'challenger', created: 240, submitted: 260 }),
    review(3, 'approved', { created: 300 })
  ])
  assert.match(out.checks.escalation, /^ok: эскалация после раунда 2/)
})

test('challenger запрошен вместе с третьим раундом и ответил позже — fail', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(2, 'changes_requested', { findings: [proven()] }),
    review(3, 'approved', { slot: 'challenger', created: 300, submitted: 400 }),
    review(3, 'changes_requested', { created: 300, submitted: 330 })
  ])
  assert.match(out.checks.escalation, /^fail/)
})

test('гипотезы и minor не делают раунд настоящим', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [guess('critical')] }),
    review(2, 'changes_requested', { findings: [proven('minor'), proven('nit')] }),
    review(3, 'approved')
  ])
  assert.equal(out.second_real_round, null)
  assert.match(out.checks.escalation, /^ok: двух настоящих раундов подряд нет/)
})

test('настоящие раунды не подряд (1 и 3) — эскалация не требуется', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(2, 'changes_requested', { findings: [guess()] }),
    review(3, 'changes_requested', { findings: [proven()] }),
    review(4, 'approved')
  ])
  assert.equal(out.second_real_round, null)
})

test('два настоящих раунда, следующего ещё нет — due, не fail', () => {
  const out = rounds([review(1, 'changes_requested', { findings: [proven()] }), review(2, 'changes_requested', { findings: [proven()] })])
  assert.match(out.checks.escalation, /^due:/)
})

test('отменённое (released) ревью не считается ни раундом, ни эскалацией', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(2, 'changes_requested', { findings: [proven()] }),
    review(3, 'released', { slot: 'challenger' }),
    review(4, 'pending', { created: 400 })
  ])
  assert.match(out.checks.escalation, /^fail: раунд 4/)
})

test('ревью нет — n/a; не массив на входе — n/a', () => {
  assert.match(rounds([]).checks.escalation, /^n\/a/)
  assert.match(rounds({ error: 'x' }).checks.escalation, /^n\/a/)
})

test('challenger, запрошенный ещё до второго настоящего раунда, эскалацией после него не считается', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(1, 'approved', { slot: 'challenger', created: 150, submitted: 260 }),
    review(2, 'changes_requested', { findings: [proven()] }),
    review(3, 'pending', { created: 300 })
  ])
  assert.match(out.checks.escalation, /^fail: раунд 3/)
})

test('после корректной эскалации новая пара настоящих раундов снова требует эскалации', () => {
  const out = rounds([
    review(1, 'changes_requested', { findings: [proven()] }),
    review(2, 'changes_requested', { findings: [proven()] }),
    review(2, 'approved', { slot: 'challenger', created: 240, submitted: 260 }),
    review(3, 'changes_requested', { findings: [proven()], created: 300, submitted: 330 }),
    review(4, 'changes_requested', { findings: [proven()], created: 400, submitted: 430 }),
    review(5, 'pending', { created: 500 })
  ])
  assert.deepEqual(out.pairs.map(p => [p.second_real_round, p.state]), [[2, 'ok'], [4, 'fail']])
  assert.match(out.checks.escalation, /^fail: раунд 5 запрошен после двух настоящих раундов \(3, 4\)/)
})
