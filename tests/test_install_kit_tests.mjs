// How the installer runs the kit's own test suite — the argv it builds, not an install.
//
// THE BUG THIS PINS. `runKitTests` used to spawn `node --test collab/test/`. Node 22
// stopped reading a directory argument as "every test file in it": the path goes to
// the module loader as a file and the run dies with MODULE_NOT_FOUND before one test
// runs, so an install that had been green refused to install. The fix enumerates the
// *.test.mjs files in Node and passes them as argv, because the two shapes that do
// work both need something this installer cannot assume — a shell to expand a glob
// (it runs on Windows, where the default shell expands nothing) or a Node that globs.
//
// Nothing here installs anything: no HOME, no ~/.agent-collab-kit, no vendor CLI, no
// MCP registration. The only child process is the real node on this machine running
// the argv the installer would have passed, in a throwaway temp tree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const lib = createRequire(import.meta.url)(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-collab-kit-install'))

// The environment a child test run needs, and it is not simply process.env: a
// `node --test` parent exports NODE_TEST_CONTEXT, and a child that inherits it
// reports in the parent's format instead of TAP — which would leave the verdict
// below with nothing to read. The installer's own childEnv() strips the same keys.
function childEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (['NODE_TEST_CONTEXT', 'NODE_OPTIONS'].includes(key)) continue
    env[key] = value
  }
  return env
}

// A stand-in for a build copy: the shape of collab/test is what matters here, not the
// tests in it. `test.mjs` (no .test), `helpers.mjs` and a nested fixture are in here
// on purpose — a discovery that swept up the wrong files would run the fixture as a
// suite and report noise at best.
function fakeKit(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-collab-kit-kittests-')))
  for (const [rel, body] of Object.entries(files)) {
    const file = join(root, 'collab', 'test', rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return root
}

const oneTest = (name) => [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  `test('${name}', () => assert.equal(1 + 1, 2))`,
  ''
].join('\n')

test('the kit-test argv names every test file, in a fixed order, and nothing else', () => {
  const root = fakeKit({
    'b.test.mjs': oneTest('b'),
    'a.test.mjs': oneTest('a'),
    'helpers.mjs': 'export const helper = 1\n',
    'test.mjs': "import { test } from 'node:test'\ntest('not a suite name', () => {})\n",
    'fixtures/lock-worker.mjs': 'process.exit(0)\n',
    'part/nested.test.mjs': oneTest('nested')
  })
  try {
    const argv = lib.kitTestArgv(root)
    assert.equal(argv[0], '--test')
    assert.deepEqual(argv.slice(1), ['collab/test/a.test.mjs', 'collab/test/b.test.mjs', 'collab/test/part/nested.test.mjs'])

    // Every argument is a real file relative to the build copy, in one spelling that
    // does not depend on the platform's separator: a directory here is the whole bug,
    // and a backslash would be a second one waiting on Windows.
    for (const arg of argv.slice(1)) {
      assert.equal(isAbsolute(arg), false, `${arg} must be relative to the build copy`)
      assert.equal(arg.includes('\\'), false, `${arg} must be forward-slashed`)
      const abs = join(root, arg)
      assert.equal(statSync(abs).isFile(), true, `${arg} must be a file, not a directory Node would have to expand`)
    }

    // Same tree, same argv: readdir order is not something to depend on.
    assert.deepEqual(lib.kitTestArgv(root), argv)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a build copy with no test file, or with no test directory, is refused clearly', () => {
  const empty = fakeKit({ 'helpers.mjs': 'export const helper = 1\n' })
  const nothing = mkdtempSync(join(tmpdir(), 'agent-collab-kit-kittests-none-'))
  try {
    // Not "no # tests line in the TAP summary": the message has to name the directory
    // that came up empty, because that is what a person has to go and look at.
    assert.throws(() => lib.kitTestArgv(empty), /no \*\.test\.mjs test file under collab\/test/)
    assert.throws(() => lib.kitTestArgv(nothing), /could not read collab\/test/)
    assert.deepEqual(lib.listTestFiles(empty), [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(nothing, { recursive: true, force: true })
  }
})

test(`this Node (${process.versions.node}) runs the argv the installer builds`, () => {
  const root = fakeKit({
    'a.test.mjs': oneTest('a'),
    'z-last.test.mjs': oneTest('z'),
    'part/nested.test.mjs': oneTest('nested')
  })
  try {
    const argv = lib.kitTestArgv(root)
    const r = spawnSync(process.execPath, argv, { cwd: root, env: childEnv(), encoding: 'utf8', timeout: 120_000 })
    assert.equal(r.status, 0, `node ${argv.join(' ')} exited ${r.status}:\n${r.stderr}`)
    const verdict = lib.tapVerdict({ status: r.status, signal: r.signal, stdout: r.stdout })
    assert.equal(verdict.ok, true, verdict.problems.join('; '))
    assert.equal(verdict.counts.tests, 3, 'the nested file is in the run, not just the two at the top')
    assert.equal(verdict.counts.fail, 0)
    for (const name of ['a', 'z', 'nested']) assert.match(r.stdout, new RegExp(`ok \\d+ - ${name}`), `${name} ran`)


  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The kit's own suite, through the installer's own discovery: the real collab/test
// in this checkout, run with the argv an install would build. This is the minute-long
// step of an install, so it is the last thing this file does.
test('the checkout\'s own collab/test passes through kitTestArgv', { timeout: 20 * 60 * 1000 }, () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const argv = lib.kitTestArgv(root)
  const kitTests = lib.listTestFiles(root)
  assert.ok(kitTests.length >= 20, `expected the whole suite, found ${kitTests.length} files`)
  for (const arg of argv.slice(1)) assert.equal(sep === '/' || !arg.includes(sep), true, 'paths are built with forward slashes')

  const r = spawnSync(process.execPath, argv, { cwd: root, env: childEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60 * 1000 })
  const verdict = lib.tapVerdict({ status: r.error ? -1 : r.status, signal: r.signal, stdout: r.stdout || '' })
  assert.equal(verdict.ok, true, `kit tests did not pass: ${verdict.problems.join('; ')}\n${verdict.failing.join('\n')}`)
  assert.equal(verdict.counts.tests, verdict.counts.pass)
})

// The two above prove the enumeration and the argv. These two prove runKitTests — the
// function an install actually calls — goes through it. Enumerating correctly in a
// helper and then handing `node --test collab/test/` to the child anyway is the same
// bug with a green test suite next to it, so the caller itself is under test.
//
// The empty tree is the pin that holds on every Node: with the directory form the run
// either dies with MODULE_NOT_FOUND (Node 22) or reports "0 tests" and fails the
// verdict as nothing ran (Node 20) — neither is the error this must give, and neither
// mentions the directory that came up empty.
test('runKitTests runs the enumerated files and returns their counts', { timeout: 5 * 60 * 1000 }, () => {
  const root = fakeKit({
    'a.test.mjs': oneTest('a'),
    'z-last.test.mjs': oneTest('z'),
    'part/nested.test.mjs': oneTest('nested')
  })
  try {
    const counts = lib.runKitTests(root, process.execPath)
    assert.equal(counts.tests, 3, 'all three files ran, the nested one included')
    assert.equal(counts.pass, 3)
    assert.equal(counts.fail, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runKitTests refuses a build copy with no test file in it', () => {
  const root = fakeKit({ 'helpers.mjs': 'export const helper = 1\n' })
  try {
    assert.throws(() => lib.runKitTests(root, process.execPath), /no \*\.test\.mjs test file under collab\/test/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
