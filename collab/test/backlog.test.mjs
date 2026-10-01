// The review backlog grouped by feature: records are read from the project's file, each goes to the first feature
// (top to bottom) whose path pattern matches, the rest to "Без фичи"; settings come only from the registry entry.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanupFeature, cleanupTask, groupByFeature, NO_FEATURE, parseBacklog, patternToRegex, readBacklog, recordsWord, suggestedRole, validateFeatures } from '../src/backlog.mjs'
import { linkForTest, tempDir, writeJson } from './helpers.mjs'

const BACKLOG = [
  '# Бэклог',
  '',
  '- [CC-3g/Экспорт] app/Story/Export/Controller.swift `awaitPublish` — тестовый шов ждёт все задачи',
  '- [CC-3/tests] app/Story/Result/Screen.swift — на шторку нет тестов — ни одного',
  '- [CC-4д/Bench] app/Story/Infra/Bench.swift:57-67 — пробный снапшоттер пишет в сессию',
  '- [CC-R4b/Карточка] app/Trips/Card.swift:202 — холостая работа',
  '- [X/Разное] tools/other.js — ничей файл',
  'просто строка, не запись'
].join('\n')

const FEATURES = [
  { name: 'Экспорт', paths: ['app/Story/**'] },
  { name: 'Карточка', paths: ['app/{Trips,Albums}/*.swift'] },
  { name: 'Всё приложение', paths: ['app/**'] }
]

test('a record is tag, path, optional line and text; a symbol before the dash stays in the text; an inner dash does not split it', () => {
  const records = parseBacklog(BACKLOG)
  assert.equal(records.length, 5)
  assert.deepEqual(records[0], { tag: 'CC-3g/Экспорт', subarea: 'Экспорт', path: 'app/Story/Export/Controller.swift', file_line: null, text: '`awaitPublish` — тестовый шов ждёт все задачи', source_line: 3 })
  assert.equal(records[1].text, 'на шторку нет тестов — ни одного')
  assert.equal(records[2].file_line, '57-67')
})

test('patterns: * stays in a segment, ** crosses them, {a,b} is a choice', () => {
  assert.ok(patternToRegex('app/*/Export/**').test('app/Story/Export/a/b.swift'))
  assert.ok(!patternToRegex('app/*/Export/**').test('app/Story/X/Export/a.swift'))
  assert.ok(patternToRegex('app/**/Card.swift').test('app/Card.swift'))
  assert.ok(patternToRegex('app/**/Card.swift').test('app/Trips/deep/Card.swift'))
  assert.ok(patternToRegex('app/{Trips,Albums}/*.swift').test('app/Albums/A.swift'))
  assert.ok(!patternToRegex('app/{Trips,Albums}/*.swift').test('app/Feed/A.swift'))
  assert.ok(!patternToRegex('app/x.swift').test('app/xyswift'), 'a dot is a dot')
})

test('the first feature top to bottom owns a record; nobody\'s records go to "Без фичи"; empty groups are left out', () => {
  const groups = groupByFeature(parseBacklog(BACKLOG), FEATURES)
  assert.deepEqual(groups.map((g) => [g.feature, g.records.length]), [['Экспорт', 3], ['Карточка', 1], [NO_FEATURE, 1]])
})

test('inside {a,b} everything is literal: a star there cannot break the pattern', () => {
  assert.ok(patternToRegex('app/{*,x}/a').test('app/*/a'))
  assert.ok(!patternToRegex('app/{*,x}/a').test('app/anything/a'))
})

test('the count reads in Russian: запись, записи, записей', () => {
  assert.deepEqual([1, 2, 4, 5, 11, 12, 21, 22, 25].map(recordsWord), ['запись', 'записи', 'записи', 'записей', 'записей', 'записей', 'запись', 'записи', 'записей'])
})

test('features.json must name every feature once and give it path patterns', () => {
  assert.deepEqual(validateFeatures(FEATURES), [])
  const problems = validateFeatures([{ name: 'A', paths: ['x/**'] }, { name: 'A', paths: ['y/**'] }, { name: '', paths: [] }]).join(' | ')
  assert.match(problems, /repeats the name "A"/)
  assert.match(problems, /has no name/)
  assert.match(problems, /non-empty list of path patterns/)
})

test('the role a cleanup goes to is the one the project names for the feature; none named — software_engineer', () => {
  const features = [{ name: 'Клиент', paths: ['app/**'], role: 'ios_engineer' }, { name: 'Сервер', paths: ['server/**'] }]
  const groups = groupByFeature(parseBacklog('- [A/x] app/A.swift — одно\n- [B/y] server/b.js — другое\n- [C/z] docs/c.md — третье'), features)
  assert.deepEqual(groups.map((g) => [g.feature, suggestedRole(g)]), [['Клиент', 'ios_engineer'], ['Сервер', 'software_engineer'], [NO_FEATURE, 'software_engineer']])
  // Nothing is guessed from where the files are: the same paths without a role in features.json get the default.
  assert.equal(suggestedRole({ records: [{ path: 'app/A.swift' }] }), 'software_engineer')
  assert.match(validateFeatures([{ name: 'X', paths: ['a/**'], role: 'Not A Role' }]).join(), /not a role id/)
  assert.deepEqual(validateFeatures([{ name: 'X', paths: ['a/**'], role: 'backend_engineer' }]), [])
})

test('the cleanup task carries the feature, the count and every record, and its title names the group back', () => {
  const [group] = groupByFeature(parseBacklog(BACKLOG), FEATURES)
  const task = cleanupTask({ ...group, count: group.records.length }, 'docs/backlog.md')
  assert.equal(task.title, 'Уборка мелочей: Экспорт (3)')
  assert.equal(cleanupFeature(task.title), 'Экспорт')
  assert.equal(task.description.split('\n').filter((l) => l.startsWith('- [')).length, 3)
  assert.deepEqual(task.files, ['app/Story/Export/Controller.swift', 'app/Story/Result/Screen.swift', 'app/Story/Infra/Bench.swift'])
})

test('readBacklog: settings only from the registry entry, the file only inside the project, an open cleanup is attached', () => {
  const base = tempDir('backlog-read-')
  try {
    const root = join(base, 'repo')
    const entry = join(base, 'registry', 'demo')
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(root, 'docs', 'backlog.md'), BACKLOG)
    assert.match(readBacklog({ projectDir: null, projectRoot: root }).reason, /не подключён/)
    writeJson(join(entry, 'project.json'), { id: 'demo', roots: [root] })
    assert.match(readBacklog({ projectDir: entry, projectRoot: root }).reason, /review_backlog/)
    writeJson(join(entry, 'project.json'), { id: 'demo', roots: [root], review_backlog: '../outside.md' })
    assert.match(readBacklog({ projectDir: entry, projectRoot: root }).reason, /внутри проекта/)
    writeJson(join(entry, 'project.json'), { id: 'demo', roots: [root], review_backlog: 'docs/backlog.md' })
    writeJson(join(entry, 'features.json'), { features: FEATURES })
    const view = readBacklog({ projectDir: entry, projectRoot: root, openTasks: [{ id: 'tsk_a_000000', title: 'Уборка мелочей: Экспорт (3)', status: 'in_progress' }] })
    assert.equal(view.total, 5)
    assert.deepEqual(view.groups[0].cleanup, { id: 'tsk_a_000000', status: 'in_progress' })
    assert.equal(view.groups[1].cleanup, null)
    assert.match(view.expect, /^[0-9a-f]{64}$/)
    // A link where the backlog should be is not followed.
    rmSync(join(root, 'docs', 'backlog.md'))
    writeFileSync(join(base, 'elsewhere.md'), BACKLOG)
    // (refused at the path check — it resolves outside the project — or, for a link inside it, as not a plain file)
    if (linkForTest(join(base, 'elsewhere.md'), join(root, 'docs', 'backlog.md'))) {
      assert.match(readBacklog({ projectDir: entry, projectRoot: root }).reason, /внутри проекта|обычным файлом/)
    }
    // Nor is a linked directory on the way out of the project.
    mkdirSync(join(base, 'outside'), { recursive: true })
    writeFileSync(join(base, 'outside', 'backlog.md'), BACKLOG)
    linkForTest(join(base, 'outside'), join(root, 'linked'))
    writeJson(join(entry, 'project.json'), { id: 'demo', roots: [root], review_backlog: 'linked/backlog.md' })
    assert.match(readBacklog({ projectDir: entry, projectRoot: root }).reason, /внутри проекта/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
