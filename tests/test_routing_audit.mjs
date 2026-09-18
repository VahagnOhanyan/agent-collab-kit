// agents/routing-audit.jq — факты о ведущей сессии из её транскрипта для пункта «Маршрутизация»
// субагента verifier. Каждый тест строит синтетический JSONL в формате транскрипта Claude Code и
// проверяет один вывод фильтра. Запуск: node --test tests/test_routing_audit.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ROUTING_AUDIT_FILTER — для негативного контроля: прогнать тесты на мутированной копии фильтра.
const FILTER = process.env.ROUTING_AUDIT_FILTER ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'routing-audit.jq')
const CWD = '/Users/tester/proj'
const PLAN = '/Users/tester/proj/.claude/plans/p.md'

// Секунды от начала сессии → ISO-время в формате транскрипта.
const at = s => new Date(Date.UTC(2026, 8, 18, 10, 0, 0) + s * 1000).toISOString()

let seq = 0
const say = (s, text) => ({ type: 'assistant', timestamp: at(s), cwd: CWD, message: { content: [{ type: 'text', text }] } })
const think = (s, thinking) => ({ type: 'assistant', timestamp: at(s), cwd: CWD, message: { content: [{ type: 'thinking', thinking }] } })
const block = (name, input, id = `toolu_${++seq}`) => ({ type: 'tool_use', id, name, input })
const msg = (s, ...blocks) => ({ type: 'assistant', timestamp: at(s), cwd: CWD, message: { content: blocks } })
const use = (s, name, input) => { const b = block(name, input); return { ...msg(s, b), _id: b.id } }
const result = (s, id, content, toolUseResult = {}) =>
  ({ type: 'user', timestamp: at(s), cwd: CWD, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, toolUseResult })

const lines = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'
const read = (s, path, n) => { const u = use(s, 'Read', { file_path: path }); return [u, result(s + 1, u._id, lines(n))] }
const bash = (s, command, out = '', end = s + 1, extra = {}) => {
  const u = use(s, 'Bash', { command, description: 'x', ...extra })
  return [u, result(end, u._id, out, { stdout: out, stderr: '', interrupted: false })]
}
const edit = (s, path) => use(s, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' })
const writePlan = (s, content, path = PLAN) => use(s, 'Write', { file_path: path, content })
const ROUTE = '# План\n\n## Назначения\n\nМаршрут: реализация — я (opus), ревью — codex sol\n'

function audit (entries, args = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'routing-audit-'))
  try {
    const file = join(dir, 't.jsonl')
    writeFileSync(file, entries.flat().map(e => typeof e === 'string' ? e : JSON.stringify((({ _id, ...rest }) => rest)(e))).join('\n') + '\n')
    const argv = ['-s', '-f', FILTER, '--arg', 'plan', args.plan ?? PLAN]
    if (args.since) argv.push('--arg', 'since', args.since)
    if (args.until) argv.push('--arg', 'until', args.until)
    const r = spawnSync('jq', [...argv, file], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- маршрут ---

test('маршрут, записанный в план до первой правки, — ok', () => {
  const out = audit([writePlan(0, ROUTE), edit(10, `${CWD}/a.swift`)])
  assert.equal(out.checks.route_in_time, 'ok')
  assert.match(out.route_marker.line, /^Маршрут: реализация/)
})

test('маршрут, дописанный в план после первой правки, — fail', () => {
  const out = audit([writePlan(0, '# План\n'), edit(10, `${CWD}/a.swift`), use(20, 'Edit', { file_path: PLAN, old_string: 'x', new_string: ROUTE })])
  assert.match(out.checks.route_in_time, /^fail: «Маршрут:» дописан в план позже первой записи/)
})

test('маршрут только в чате, в thinking, в промпте субагенту или в плане другой задачи — не засчитывается', () => {
  const out = audit([
    say(0, '**Маршрут:** всё делаю сам'),
    think(1, 'Маршрут: всё сам'),
    use(2, 'Agent', { subagent_type: 'Explore', model: 'haiku', prompt: 'Маршрут: ...\nСмета: ...' }),
    writePlan(3, ROUTE, '/Users/tester/proj/.claude/plans/old-task.md'),
    writePlan(4, '# План\n'),
    edit(10, `${CWD}/a.swift`)
  ])
  assert.match(out.checks.route_in_time, /^fail: в плане нет строки «Маршрут:»/)
  assert.ok(out.route_said_in_chat, 'реплика видна как справка, но не засчитывается')
})

test('слово «Маршрут:» в середине строки плана маркером не считается', () => {
  const out = audit([writePlan(0, 'Правило требует строку «Маршрут: …» до правки\n'), edit(10, `${CWD}/a.swift`)])
  assert.match(out.checks.route_in_time, /^fail/)
})

test('план записан вне транскрипта — unknown; план не передан — unknown', () => {
  assert.match(audit([edit(10, `${CWD}/a.swift`)]).checks.route_in_time, /^unknown: запись плана вне транскрипта/)
  assert.match(audit([say(0, 'привет')]).checks.route_in_time, /^unknown: запись плана вне транскрипта/)
  assert.match(audit([edit(10, `${CWD}/a.swift`)], { plan: '' }).checks.route_in_time, /^unknown: план не передан/)
})

test('запись плана и правка в одном сообщении с одним временем — порядок по блокам, ok', () => {
  const same = msg(5, block('Write', { file_path: PLAN, content: ROUTE }), block('Edit', { file_path: `${CWD}/a.swift`, old_string: 'a', new_string: 'b' }))
  assert.equal(audit([same]).checks.route_in_time, 'ok')
  const reversed = msg(5, block('Edit', { file_path: `${CWD}/a.swift`, old_string: 'a', new_string: 'b' }), block('Write', { file_path: PLAN, content: ROUTE }))
  assert.match(audit([reversed]).checks.route_in_time, /^fail/)
})

test('правка плана, памяти и /tmp — не первая правка', () => {
  const out = audit([
    writePlan(0, ROUTE),
    edit(1, '/Users/tester/.claude/projects/-Users-tester-proj/memory/x.md'),
    edit(2, '/private/tmp/claude-501/x/scratchpad/n.txt'),
    use(5, 'Edit', { file_path: PLAN, old_string: 'x', new_string: 'уточнение' }),
    edit(10, `${CWD}/a.swift`)
  ])
  assert.equal(out.first_edit.path, `${CWD}/a.swift`)
  assert.equal(out.checks.route_in_time, 'ok')
})

test('правка через sed -i, > и tee — тоже первая правка', () => {
  for (const cmd of [`sed -i '' 's/a/b/' ${CWD}/a.swift`, `echo x > ${CWD}/b.json`, `printf x | tee ${CWD}/c.yml`]) {
    const out = audit([bash(0, cmd), writePlan(10, ROUTE)])
    assert.equal(out.first_edit?.via, 'Bash', cmd)
    assert.match(out.checks.route_in_time, /^fail/, cmd)
  }
  const tmpOnly = audit([bash(0, 'echo x > /tmp/log.txt 2>&1; cat a.swift >/dev/null'), writePlan(10, ROUTE)])
  assert.equal(tmpOnly.first_edit, null)
})

// --- разведка ---

test('разведка ниже порога — ok; выше по строкам — fail', () => {
  assert.equal(audit([read(0, `${CWD}/a.swift`, 120), read(2, `${CWD}/b.swift`, 120)]).checks.recon_under_threshold, 'ok')
  const out = audit([read(0, `${CWD}/a.swift`, 300), read(2, `${CWD}/b.swift`, 300)])
  assert.match(out.checks.recon_under_threshold, /^fail: 2 файлов, 600 строк/)
})

test('больше трёх прочитанных файлов — fail', () => {
  const out = audit([1, 2, 3, 4].map(i => read(i * 2, `${CWD}/f${i}.swift`, 30)))
  assert.equal(out.recon.files, 4)
  assert.match(out.checks.recon_under_threshold, /^fail: 4 файлов/)
})

test('файл, который сессия потом правила, и .md — не разведка', () => {
  const out = audit([
    read(0, `${CWD}/edited.swift`, 900),
    read(2, `${CWD}/docs/big.md`, 900),
    edit(10, `${CWD}/edited.swift`)
  ])
  assert.equal(out.recon.lines, 0)
  assert.equal(out.checks.recon_under_threshold, 'ok')
})

test('чтение через Bash: cd учитывается, grep-подглядывание — строки, но не файл', () => {
  const out = audit([
    bash(0, 'cd ~/kit && cat hooks/guard.py', lines(40)),
    bash(2, 'grep -n foo src/one.swift src/two.swift', lines(3)),
    bash(4, "sed -n 's/a/b/p' origin/main", lines(1))
  ])
  assert.deepEqual(out.recon.paths, ['/Users/tester/kit/hooks/guard.py'])
  assert.equal(out.recon.lines, 43)
})

test('путь через переменную той же команды раскрывается; нераскрытый — строки без файла', () => {
  const out = audit([
    bash(0, 'F=/Users/tester/proj/big.swift; cat $F', lines(30)),
    bash(2, 'P=/Users/tester/logs; S=run; tail -50 ${P}/$S.log', lines(25)),
    bash(4, 'cat "$1"', lines(600))
  ])
  assert.deepEqual(out.recon.paths, ['/Users/tester/logs/run.log', '/Users/tester/proj/big.swift'])
  assert.equal(out.recon.lines, 655)
  assert.match(out.checks.recon_under_threshold, /^fail/)
})

test('результат Read без разбора — unknown, а не ok', () => {
  const u = use(0, 'Read', { file_path: `${CWD}/a.swift` })
  const out = audit([u])
  assert.equal(out.recon.unparsed_reads, 1)
  assert.match(out.checks.recon_under_threshold, /^unknown/)
})

test('объявление «разведка — ведущая сессия» засчитывается, только если записано в план до правки', () => {
  const decl = '## Назначения\nМаршрут: я\n| Разведка — ведущая сессия, потому что файлы правлю сам |\n'
  assert.equal(audit([writePlan(0, decl), edit(10, `${CWD}/a.swift`)]).recon.declared_in_plan_in_time, true)
  const row = '## Назначения\nМаршрут: я\n| Разведка | ведущая сессия | opus | читаю только файлы, которые правлю |\n'
  assert.equal(audit([writePlan(0, row), edit(10, `${CWD}/a.swift`)]).recon.declared_in_plan_in_time, true)
  const late = audit([writePlan(0, ROUTE), edit(10, `${CWD}/a.swift`), use(20, 'Edit', { file_path: PLAN, old_string: 'x', new_string: decl })])
  assert.equal(late.recon.declared_in_plan_in_time, false)
})

// --- делегирования ---

test('Agent без модели — fail; с моделью — ok; fork — требует объявления', () => {
  const ok = audit([use(0, 'Agent', { subagent_type: 'Explore', model: 'haiku', prompt: 'p' })])
  assert.equal(ok.checks.delegation_models, 'ok')
  assert.equal(ok.checks.forks, 'n/a')
  const fork = audit([use(1, 'Agent', { subagent_type: 'fork', prompt: 'p' })])
  assert.match(fork.checks.forks, /^declare: 1 fork/)
  const bad = audit([use(0, 'Agent', { subagent_type: 'Explore', prompt: 'p' })])
  assert.equal(bad.agents.without_model, 1)
  assert.match(bad.checks.delegation_models, /^fail/)
})

test('codex/agy без модели — fail, в том числе через env и путь к бинарю', () => {
  for (const cmd of [
    'codex exec -s read-only -C /x -o y "prompt"',
    'env CODEX_HOME=/x codex exec -s read-only "p"',
    '/opt/homebrew/bin/codex exec "p"',
    'agy -p "x"'
  ]) assert.equal(audit([bash(0, cmd)]).external_without_model.length, 1, cmd)
})

test('codex/agy с моделью, в шаблоне pgrep, --help и слово agy в echo — не делегирование без модели', () => {
  const ok = audit([
    bash(0, 'codex exec -m gpt-5.6-sol -s read-only "p"'),
    bash(1, 'agy --model gemini-3.1-pro-low --mode plan -p "x"'),
    bash(2, "pgrep -f 'ios-test.sh|codex exec' | wc -l", '0\n'),
    bash(3, 'codex exec --help | head'),
    bash(4, 'echo "children of agy"; ps -o pid -p 1')
  ])
  assert.deepEqual(ok.external_without_model, [])
  assert.equal(ok.checks.delegation_models, 'ok')
})

// --- сборки и смета ---

const build = (s, min = 10) => bash(s, 'scripts/ios-test.sh --build FooTests', 'ok\n', s + min * 60)

test('сборки 20 мин без сметы — fail; со сметой до сборок — ok; 10 мин — n/a', () => {
  assert.match(audit([build(0), build(700)]).checks.smeta_before_builds, /^fail: 20 мин машинного времени/)
  assert.equal(audit([say(0, 'Смета: 2 сборки × 10 мин = 20 мин'), build(10), build(710)]).checks.smeta_before_builds, 'ok')
  assert.equal(audit([writePlan(0, '## Назначения\nСмета: 20 мин\n'), build(10), build(710)]).checks.smeta_before_builds, 'ok')
  assert.match(audit([build(0)]).checks.smeta_before_builds, /^n\/a/)
})

test('короткая проверочная сборка до сметы не даёт ложный FAIL; смета после сборки, перевалившей 15 мин, — fail', () => {
  const quickThenSmeta = [build(0, 2), say(200, 'Смета: 2 × 10 мин'), build(300), build(1000)]
  assert.equal(audit(quickThenSmeta).checks.smeta_before_builds, 'ok')
  const late = [build(0, 10), build(700, 10), say(1400, 'Смета: ещё 10 мин')]
  assert.match(audit(late).checks.smeta_before_builds, /^fail/)
})

test('фоновая сборка меряется по уведомлению о завершении, без уведомления — unknown', () => {
  const u = use(0, 'Bash', { command: 'xcodebuild build-for-testing', description: 'x', run_in_background: true })
  const started = result(1, u._id, 'started', { stdout: '', stderr: '', backgroundTaskId: 'b1' })
  const done = { type: 'queue-operation', operation: 'enqueue', timestamp: at(1200),
    content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${u._id}</tool-use-id>\n<status>completed</status>` }
  const measured = audit([u, started, done])
  assert.equal(measured.builds.measured_minutes, 20)
  assert.match(measured.checks.smeta_before_builds, /^fail: 20 мин машинного времени/)
  const u2 = use(0, 'Bash', { command: 'xcodebuild build-for-testing', description: 'x', run_in_background: true })
  const unmeasured = audit([u2, result(1, u2._id, 'started', { stdout: '', stderr: '', backgroundTaskId: 'b2' })])
  assert.equal(unmeasured.builds.unmeasured, 1)
  assert.match(unmeasured.checks.smeta_before_builds, /^unknown/)
})

// --- окно и устойчивость ---

test('окно since / until отрезает другие задачи сессии', () => {
  const entries = [read(0, `${CWD}/old.swift`, 900), say(100, 'новая задача'), read(110, `${CWD}/new.swift`, 50), read(500, `${CWD}/later.swift`, 900)]
  assert.match(audit(entries).checks.recon_under_threshold, /^fail/)
  const out = audit(entries, { since: at(100), until: at(200) })
  assert.equal(out.recon.lines, 50)
  assert.equal(out.checks.recon_under_threshold, 'ok')
})

test('чужие формы полей не роняют фильтр: command-объект, строковый toolUseResult, битое время, мусорная строка', () => {
  const out = audit([
    use(0, 'Bash', { command: ['cat', 'a.swift'] }),
    { type: 'user', timestamp: at(1), message: { content: 'plain text' }, toolUseResult: 'Error: boom' },
    { type: 'assistant', timestamp: 'not-a-date', message: { content: [block('Bash', { command: 'xcodebuild build' })] } },
    'null',
    say(5, 'ok')
  ])
  assert.equal(out.format, 'claude-code-jsonl')
})

test('транскрипт без tool_use — format unrecognized', () => {
  assert.equal(audit([say(0, 'привет')]).format, 'unrecognized')
  assert.equal(audit([edit(0, `${CWD}/a.swift`)]).format, 'claude-code-jsonl')
})

// --- машинное время, потолок 60 мин (v3) ---

const human = (s, text) => ({ type: 'user', timestamp: at(s), cwd: CWD, origin: { kind: 'human' }, message: { content: text } })
const notification = s => ({ type: 'user', timestamp: at(s), cwd: CWD, origin: { kind: 'task-notification' }, message: { content: '<task-notification>x</task-notification>' } })

test('долгая команда без маркера сборки и долгий внешний агент — машинное время; ожидание sleep — нет', () => {
  const out = audit([
    bash(0, 'bash run-checks.sh > log.txt', 'ok\n', 1200),
    bash(2000, 'agy --model gemini-3.1-pro-low -p "пиши тесты и гоняй их"', '', 2600),
    bash(3000, 'until grep -q done log.txt; do sleep 30; done', '', 4800)
  ])
  assert.equal(out.builds.measured_minutes, 30)
  assert.deepEqual(out.builds.list.map(b => b.kind), ['long', 'external'])
  assert.match(out.checks.smeta_before_builds, /^fail/)
})

test('после 60 мин следующая сборка без реплики владельца — fail; уведомление репликой не считается', () => {
  const out = audit([say(0, 'Смета: 3 × 35 мин'), build(10, 35), build(2200, 35), notification(4400), build(4500, 5)])
  assert.match(out.checks.ceiling_60, /^fail: после 70 мин/)
})

test('после 60 мин: доклад со сметой и ответ владельца или вопрос AskUserQuestion — ok; просто реплика — fail', () => {
  const ask = use(4400, 'AskUserQuestion', { questions: [{ question: 'Смета: ещё 2 сборки × 5 мин. Продолжать?' }] })
  const offTopic = use(4400, 'AskUserQuestion', { questions: [{ question: 'Какой вариант шапки оставить?' }] })
  assert.match(audit([build(10, 35), build(2200, 35), say(4300, 'Смета: ещё 1 × 5 мин, итого 75'), human(4400, 'продолжай'), build(4500, 5)]).checks.ceiling_60, /^ok: после 60 мин доклад/)
  assert.match(audit([build(10, 35), build(2200, 35), ask, result(4410, ask._id, 'answered'), build(4500, 5)]).checks.ceiling_60, /^ok: после 60 мин доклад/)
  assert.match(audit([build(10, 35), build(2200, 35), human(4400, 'а тесты зелёные?'), build(4500, 5)]).checks.ceiling_60, /^fail: после 70 мин владелец отвечал, но доклада/)
  assert.match(audit([build(10, 35), build(2200, 35), offTopic, result(4410, offTopic._id, 'A'), build(4500, 5)]).checks.ceiling_60, /^fail: после 70 мин владелец отвечал, но доклада/)
  assert.match(audit([build(10, 35), build(2200, 35), human(4300, 'ок'), say(4400, 'Смета: ещё 5 мин'), build(4500, 5)]).checks.ceiling_60, /^fail/)
  assert.match(audit([build(10, 35), build(2200, 35)]).checks.ceiling_60, /^ok: после 60 мин машинных команд не было/)
  assert.match(audit([build(10, 35)]).checks.ceiling_60, /^n\/a/)
})

// --- мутации (v3) ---

test('--iterations на целом классе — fail; на одном тесте — ok; 1 итерация — n/a', () => {
  assert.match(audit([bash(0, 'scripts/ios-test.sh --build --iterations 20 --label x FooTests')]).checks.mutation_iterations, /^fail: 1 прогонов/)
  assert.equal(audit([bash(0, 'scripts/ios-test.sh --iterations 20 FooTests/testFlaky')]).checks.mutation_iterations, 'ok')
  assert.equal(audit([bash(0, 'scripts/ios-test.sh --iterations 1 FooTests')]).checks.mutation_iterations, 'n/a')
})

test('полный набор мутаций скриптом дважды — fail; выборочные id — ok; pkill и запись скрипта — не прогоны', () => {
  const twice = audit([bash(0, 'bash "$S/run-stageB-controls.sh" > /tmp/a.log 2>&1'), bash(10, '"$S/run-stageB-controls.sh"')])
  assert.equal(twice.mutations.full_set_runs, 2)
  assert.match(twice.checks.mutation_full_set, /^fail: полный набор мутаций прогнан 2 раз/)
  const once = audit([
    bash(0, './run-stageB-controls.sh'),
    bash(10, './run-stageB-controls.sh clean B1 B2 > /tmp/r2.log'),
    bash(20, 'pkill -f "run-stageB-controls.sh"; cat > run-stageB-controls.sh <<SH\nx\nSH'),
    bash(30, 'chmod +x run-stageB-controls.sh')
  ])
  assert.equal(once.mutations.full_set_runs, 1)
  assert.equal(once.checks.mutation_full_set, 'ok')
})

test('все мутации перегнаны заново поштучно — второй полный набор, fail', () => {
  const ids = ['A', 'B', 'C']
  const runs = [...ids, ...ids].map((id, i) => bash(i * 10, `scripts/ios-test.sh --label mut-${id} FooTests/test${id}`))
  assert.match(audit(runs).checks.mutation_full_set, /^fail: все 3 мутаций перегнаны повторно/)
  const partial = [...ids, 'A'].map((id, i) => bash(i * 10, `scripts/ios-test.sh --label mut-${id} FooTests/test${id}`))
  assert.equal(audit(partial).checks.mutation_full_set, 'ok')
})

test('мутация своим тестом: mut-<id> на одном Класс/тест — ok, на целом классе — fail, через скрипт — unknown', () => {
  assert.equal(audit([bash(0, 'scripts/ios-test.sh --label mut-A FooTests/testA')]).checks.mutation_own_test, 'ok')
  assert.match(audit([bash(0, 'scripts/ios-test.sh --build --label mut-A FooTests')]).checks.mutation_own_test, /^fail: мутация не своим тестом.*A/)
  assert.match(audit([bash(0, './run-x-mutations.sh B1')]).checks.mutation_own_test, /^unknown/)
})

// --- находки ревью раунда 2 ---

test('удаление строки «Маршрут:» из плана (old_string) не засчитывается как маршрут', () => {
  const out = audit([
    writePlan(0, '# План\n'),
    use(5, 'Edit', { file_path: PLAN, old_string: 'Маршрут: opus\nРазведка — ведущая сессия, потому что x', new_string: 'удалено' }),
    edit(10, `${CWD}/a.swift`)
  ])
  assert.match(out.checks.route_in_time, /^fail: в плане нет строки «Маршрут:»/)
  assert.equal(out.recon.declared_in_plan_in_time, false)
  const multi = audit([use(0, 'MultiEdit', { file_path: PLAN, edits: [{ old_string: 'a', new_string: ROUTE }] }), edit(10, `${CWD}/a.swift`)])
  assert.equal(multi.checks.route_in_time, 'ok')
})

test('текст внутри heredoc и в echo — не прогоны: ни итерации, ни мутации, ни сборки', () => {
  const heredoc = "cat >> tests/t.mjs <<'EOF'\nbash(0, 'scripts/ios-test.sh --iterations 20 --label mut-A FooTests')\nxcodebuild test\nEOF\nnode --check tests/t.mjs"
  const out = audit([bash(0, heredoc), bash(5, 'echo "scripts/ios-test.sh --iterations 20 FooTests"')])
  assert.equal(out.checks.mutation_iterations, 'n/a')
  assert.equal(out.checks.mutation_own_test, 'n/a')
  assert.deepEqual(out.builds.list.map(b => b.cmd.slice(0, 3)), [])
  assert.equal(out.first_edit?.path, `${CWD}/tests/t.mjs`, 'а сама запись через heredoc — правка файла')
})

// --- якорь маршрута — план, а не правка (v5) ---

test('правки только скриптом (не видны): маршрут в первой записи плана — ok, дописан позже — fail', () => {
  const script = "python3 - <<'PY'\nopen('a.swift','w').write('x')\nPY"
  const ok = audit([writePlan(0, ROUTE), bash(10, script)])
  assert.equal(ok.first_edit, null, 'правку скриптом фильтр не видит')
  assert.equal(ok.checks.route_in_time, 'ok')
  const late = audit([writePlan(0, '# План\n'), bash(10, script), use(20, 'Edit', { file_path: PLAN, old_string: 'x', new_string: ROUTE })])
  assert.match(late.checks.route_in_time, /^fail: «Маршрут:» дописан в план позже первой записи/)
})

test('план показан владельцу: черновик без маршрута, маршрут дописан до показа — ok; после показа — fail', () => {
  const show = s => use(s, 'ExitPlanMode', {})
  const ok = audit([writePlan(0, '# План, черновик\n'), use(5, 'Edit', { file_path: PLAN, old_string: 'x', new_string: ROUTE }), show(8), edit(10, `${CWD}/a.swift`)])
  assert.equal(ok.plan_shown_to_owner, true)
  assert.equal(ok.checks.route_in_time, 'ok')
  const late = audit([writePlan(0, '# План\n'), show(5), use(8, 'Edit', { file_path: PLAN, old_string: 'x', new_string: ROUTE })])
  assert.match(late.checks.route_in_time, /^fail: «Маршрут:» дописан в план после показа владельцу/)
})

test('объявление разведки: в первой записи или до показа — вовремя; дописано после — нет', () => {
  const decl = '## Назначения\nМаршрут: я\n| Разведка | ведущая сессия | opus | правлю эти же файлы |\n'
  assert.equal(audit([writePlan(0, '# План\n'), use(5, 'Edit', { file_path: PLAN, old_string: 'x', new_string: decl }), use(8, 'ExitPlanMode', {})]).recon.declared_in_plan_in_time, true)
  assert.equal(audit([writePlan(0, ROUTE), use(5, 'ExitPlanMode', {}), use(8, 'Edit', { file_path: PLAN, old_string: 'x', new_string: decl })]).recon.declared_in_plan_in_time, false)
})

test('задача в два захода: первый план показан без маршрута — для всей задачи fail, для второго захода (since) — ok', () => {
  const entries = [
    writePlan(0, '# План v1\n'), use(5, 'ExitPlanMode', {}), edit(10, `${CWD}/a.swift`),
    human(100, 'давай ещё'),
    writePlan(110, '# План v2\n\n## Назначения\nМаршрут: я (opus)\n'), use(115, 'ExitPlanMode', {}), edit(120, `${CWD}/b.swift`)
  ]
  assert.match(audit(entries).checks.route_in_time, /^fail/)
  assert.equal(audit(entries, { since: at(100) }).checks.route_in_time, 'ok')
})

test('мутация на тест-классе с именем не по шаблону …Tests — unknown, а не ложный FAIL', () => {
  assert.match(audit([bash(0, 'scripts/ios-test.sh --label mut-A FooSpec/testA')]).checks.mutation_own_test, /^unknown: цель мутации не распознана \(A\)/)
  assert.match(audit([bash(0, 'scripts/ios-test.sh --label mut-A FooTests')]).checks.mutation_own_test, /^fail/)
})

// --- находки раунда 3 ---

test('смета из прошлого захода (до since) не покрывает сборки этого захода', () => {
  const entries = [writePlan(0, '## Назначения\nСмета: 10 мин\n'), human(3000, 'новая задача'), build(3100, 10), build(3800, 10)]
  assert.equal(audit(entries).checks.smeta_before_builds, 'ok')
  assert.match(audit(entries, { since: at(3000) }).checks.smeta_before_builds, /^fail: 20 мин/)
})

test('шаблоны поиска и глоба — не прочитанные файлы', () => {
  const out = audit([
    bash(0, "grep -oE 'ios-test\\.sh|run-stage[A-Za-z-]*\\.sh' log.txt", lines(30)),
    bash(2, "ls ./*.swift | head", lines(25))
  ])
  assert.deepEqual(out.recon.paths, [`${CWD}/log.txt`])
})

// --- находки раунда 4 ---

test('смета в вопросе AskUserQuestion засчитывается и для правила 15 минут', () => {
  const ask = use(0, 'AskUserQuestion', { questions: [{ question: 'Смета: 2 × 10 мин. Запускать?' }] })
  assert.equal(audit([ask, result(1, ask._id, 'да'), build(10, 10), build(700, 10)]).checks.smeta_before_builds, 'ok')
})

test('чтение по глобу без кавычек (cat ./*.swift) — строки разведки, а не ноль', () => {
  const out = audit([bash(0, 'cat ./*.swift', lines(600))])
  assert.equal(out.recon.lines, 600)
  assert.match(out.checks.recon_under_threshold, /^fail/)
  const quoted = audit([bash(0, "grep -oE 'ios-test\\.sh' log.txt", lines(3))])
  assert.equal(quoted.recon.lines, 3, 'шаблон в кавычках не глоб, а log.txt — путь')
})
