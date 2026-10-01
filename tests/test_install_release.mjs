// Installing a release: layout checks, the clean install, reinstall and rollback.
// Runs the kit's own test suite once (the clean install); everything else
// passes --skip-kit-tests.
//
// Shared world and fakes: tests/helpers/install-world.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, IS_WINDOWS, LAUNCHER_NAME, readLink, currentTarget, lib, NODE, git, cleanEnv, makeSource, commitChange, shaOf, makeWorld, snapshot, mutating, expectedBlock, CODEX_FIXTURE } from './helpers/install-world.mjs'

const world = setup()

// ── integration ────────────────────────────────────────────────────────────

test('a source missing required agents, skills, hooks or launcher is refused before anything runs', () => {
  const W = makeWorld('layout')
  const partial = makeSource('layout', (dir) => {
    rmSync(join(dir, 'agents'), { recursive: true, force: true })
    rmSync(join(dir, 'hooks', 'scope-guard.mjs'))
  })
  const before = W.snapshot()
  const r = W.run(['--source', partial, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /is missing required paths:\n {2}- agents\/implementer\.md\n {2}- agents\/verifier\.md\n {2}- hooks\/scope-guard\.mjs\n/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(W.claudeCalls(), [])
})

test('the handshake must list exactly the tools of the release tools.mjs', () => {
  const W = makeWorld('tools')
  const needle = 'serve({ api: getApi })'
  const mismatched = makeSource('tools', (dir) => {
    const file = join(dir, 'collab', 'src', 'mcp', 'server.mjs')
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes(needle), 'server.mjs changed shape; update this test')
    writeFileSync(file, text.replace(needle, 'serve({ api: getApi, tools: TOOLS.slice(1) })'))
  })
  const before = W.snapshot()
  const r = W.run(['--source', mismatched, '--skip-kit-tests'])
  assert.notEqual(r.status, 0, r.all)
  assert.match(r.stderr, /tools\/list does not match collab\/src\/mcp\/tools\.mjs of this release: \d+ tools listed, tools\.mjs defines \d+; missing: \w+/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

test('a collab registration outside user scope is refused with its exact scope text, even with --replace-claude', () => {
  const W = makeWorld('project-scope', { claudeState: { collab: { scope: 'project', command: 'node', args: ['tools/collab/src/mcp/server.mjs'], env: {} } } })
  const before = W.snapshot()
  const r = W.run(['--source', world.source, '--skip-kit-tests', '--replace-claude'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /shows "collab" with Scope: Project config \(shared via \.mcp\.json\)\n/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

let A // the world shared by the install → reinstall → rollback sequence
let SHA1

test('clean install: kit tests green, release activated, links, Claude and Codex registered', () => {
  A = makeWorld('main')
  SHA1 = shaOf(world.source)
  const r = A.run(['--source', world.source])
  assert.equal(r.status, 0, r.all)

  assert.match(r.stdout, /kit tests: \d+ tests, \d+ pass, 0 fail, 0 skipped, 0 cancelled/)
  assert.match(r.stdout, /smoke: check-config ok; MCP initialize \+ tools\/list = \d+ tools, same names as tools\.mjs; whoami -> NOT_INITIALIZED; nothing created/)
  assert.ok(r.stdout.includes(`node for registrations: ${NODE}\n`), r.stdout)
  assert.match(r.stdout, new RegExp(`installed: ${SHA1}`))
  assert.match(r.stdout, /previous: {2}none/)
  assert.match(r.stdout, /rollback: {2}.*agent-collab-kit-install --rollback/)
  assert.match(r.stdout, /перезапустите открытые сессии Claude, Codex и Gemini/)

  assert.equal(readLink(A.kit('current')), currentTarget(A.home, SHA1))
  assert.ok(existsSync(A.kit('releases', SHA1, 'collab', 'src', 'mcp', 'server.mjs')))
  assert.deepEqual(readdirSync(A.kit('tmp')), [], 'build dir moved away')
  const [entry] = A.history()
  assert.equal(A.history().length, 1)
  assert.equal(entry.sha, SHA1)
  assert.equal(entry.previous, null)
  assert.equal(entry.kit_tests, 'passed')
  assert.ok(!Number.isNaN(Date.parse(entry.at)))

  const cur = A.kit('current')
  // Skills and agents: a symlinked directory/file under ~/.claude/skills or
  // ~/.claude/agents is invisible to Claude Code's own discovery (confirmed
  // 2026-09-16), so on POSIX these four are real copies refreshed from
  // `current` on every install/rollback (posixCopy in agent-collab-kit-install's
  // linkSpecs) — not symlinks, unlike everything else user-level here.
  // Windows was always a copy for the agents (no admin-free file symlink);
  // this only changes POSIX and adds the same treatment for directories.
  for (const skill of ['codex-review', 'ui-review']) {
    const dest = join(A.home, '.claude', 'skills', skill)
    assert.equal(lstatSync(dest).isSymbolicLink(), false, `${skill} is a real directory, not a symlink`)
    assert.ok(readFileSync(join(dest, 'SKILL.md')).equals(readFileSync(join(cur, 'skills', skill, 'SKILL.md'))))
  }
  for (const agent of ['implementer', 'verifier']) {
    const dest = join(A.home, '.claude', 'agents', `${agent}.md`)
    assert.equal(lstatSync(dest).isSymbolicLink(), false, `${agent}.md is a real file, not a symlink`)
    assert.ok(readFileSync(dest).equals(readFileSync(join(cur, 'agents', `${agent}.md`))))
  }
  // The orchestration rule is installed the same way (linkSpecs, 2026-09-17).
  const rule = join(A.home, '.claude', 'rules', 'orchestration.md')
  assert.equal(lstatSync(rule).isSymbolicLink(), false, 'orchestration.md is a real file, not a symlink')
  assert.ok(readFileSync(rule).equals(readFileSync(join(cur, 'rules', 'orchestration.md'))))
  assert.equal(readFileSync(join(A.home, '.claude', 'rules', 'my-own-rule.md'), 'utf8'), 'mine\n', 'unrelated rule kept')
  // The bindir launcher is unaffected: it is exec'd directly, not scanned by
  // any skill/agent discovery, so it stays a plain symlink on POSIX.
  if (!IS_WINDOWS) {
    assert.equal(readlinkSync(join(A.bindir, 'collab')), join(cur, 'bin', 'collab'))
  } else {
    assert.match(readFileSync(join(A.bindir, 'collab.cmd'), 'utf8'), /node "/)
  }
  assert.ok(existsSync(join(A.home, '.claude', 'skills', 'codex-review', 'SKILL.md')), 'copy resolves')
  assert.ok(existsSync(join(A.home, '.claude', 'skills', 'my-own-skill', 'SKILL.md')), 'unrelated skill kept')
  const launcher = spawnSync(join(A.bindir, LAUNCHER_NAME), ['check-config'], { encoding: 'utf8', env: cleanEnv(), shell: IS_WINDOWS })
  assert.equal(launcher.status, 0, launcher.stderr)

  const server = join(A.home, '.agent-collab-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  assert.deepEqual(mutating(A.claudeCalls()), [['mcp', 'add', '-s', 'user', 'collab', '-e', 'COLLAB_AGENT_ID=claude', '--', NODE, server]])
  assert.deepEqual(A.claudeState().collab, { scope: 'user', command: NODE, args: [server], env: { COLLAB_AGENT_ID: 'claude' } })

  const config = readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8')
  assert.equal(config, `${CODEX_FIXTURE}\n${expectedBlock(A.home)}\n`)
  const backups = readdirSync(join(A.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(A.home, '.codex', backups[0]), 'utf8'), CODEX_FIXTURE)
  assert.equal(A.codexCalls(), '', 'codex itself is never run')
  assert.ok(!existsSync(join(A.home, '.agent-collab-kit.lock')))
})

test('a gitignored project registry on disk is copied into the release, not just projects/README.md from the archive', () => {
  // Regression, 2026-09-15: projects/<id>/ became .gitignore'd (README.md:
  // "вне самих репозиториев") without adding a step to carry it into a new
  // release — `git archive` only ever sees tracked files, so every release
  // built after that change silently shipped an empty registry (just the
  // tracked projects/README.md), and every registered project's config
  // fell back to built-in defaults with no error at install time.
  const W = makeWorld('project-registry')
  const source = makeSource('project-registry', (dir) => {
    // TEMPLATE excludes 'projects' entirely (see before()) so this fixture
    // stands alone: a tracked README.md (mirrors the real repo's own
    // projects/README.md, committed by makeSource like everything else
    // mutate writes) plus a gitignored registry entry (mirrors a real
    // projects/<id>/, never committed).
    mkdirSync(join(dir, 'projects', 'test-registry-fixture'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'README.md'), 'test fixture\n')
    // `roots` is required (a non-empty array of absolute paths, per the
    // schema in README.md's "Подключить проект") — the installer's own
    // `bin/collab check-config` smoke test validates every registered
    // project, this fixture included, so it has to be schema-valid, not
    // just present.
    writeFileSync(
      join(dir, 'projects', 'test-registry-fixture', 'project.json'),
      `${JSON.stringify({ id: 'test-registry-fixture', roots: ['/tmp/test-registry-fixture'] }, null, 2)}\n`
    )
  })
  // Confirms the fixture is actually gitignored (as a real project.json
  // under projects/<id>/ always is) — otherwise this test would not be
  // exercising the disk-copy path this fix adds, just `git archive`.
  assert.equal(git(source, ['check-ignore', 'projects/test-registry-fixture']), 'projects/test-registry-fixture')

  const sha = shaOf(source)
  const r = W.run(['--source', source])
  assert.equal(r.status, 0, r.all)

  const copied = W.kit('releases', sha, 'projects', 'test-registry-fixture', 'project.json')
  assert.ok(existsSync(copied), 'gitignored project registry entry copied from disk into the release')
  assert.deepEqual(JSON.parse(readFileSync(copied, 'utf8')), { id: 'test-registry-fixture', roots: ['/tmp/test-registry-fixture'] })
  // The tracked README.md still comes through too, via the archive as before.
  assert.ok(existsSync(W.kit('releases', sha, 'projects', 'README.md')))
})

test('reinstalling the same commit changes nothing', () => {
  assert.ok(A, 'depends on the clean install')
  const before = A.snapshot()
  const callsBefore = A.claudeCalls().length
  const r = A.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
  assert.deepEqual(A.snapshot(), before)
  const newCalls = A.claudeCalls().slice(callsBefore)
  assert.ok(newCalls.length > 0 && newCalls.every((argv) => argv[1] === 'get'), JSON.stringify(newCalls))
})

test('rollback switches current and the links follow; repeated rollback walks back; old releases are pruned', () => {
  assert.ok(A, 'depends on the clean install')
  const skill = join(A.home, '.claude', 'skills', 'codex-review', 'SKILL.md')
  const original = readFileSync(join(world.source, 'skills', 'codex-review', 'SKILL.md'), 'utf8')
  const sha2 = commitChange(world.source, 'skills/codex-review/SKILL.md', `${original}\nrelease-two marker\n`)
  let r = A.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readLink(A.kit('current')), currentTarget(A.home, sha2))
  assert.match(readFileSync(skill, 'utf8'), /release-two marker/)
  assert.match(r.stdout, new RegExp(`previous: {2}${SHA1}`))
  const callsBefore = A.claudeCalls().length
  const codexBefore = readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8')

  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`rolled back: ${sha2} -> ${SHA1}`))
  assert.equal(readLink(A.kit('current')), currentTarget(A.home, SHA1))
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /release-two marker/)
  if (!IS_WINDOWS) {
    assert.equal(realpathSync(join(A.bindir, 'collab')), realpathSync(A.kit('releases', SHA1, 'bin', 'collab')))
  } else {
    // The shim only ever names ctx.currentPath, never a specific release — it
    // does not change across a rollback, unlike the POSIX symlink it replaces.
    assert.equal(readFileSync(join(A.bindir, 'collab.cmd'), 'utf8'), lib.cmdShimContent({ currentPath: A.kit('current') }).toString('utf8'))
  }
  assert.deepEqual(A.history().at(-1), { ...A.history().at(-1), sha: SHA1, previous: sha2, action: 'rollback' })
  assert.equal(A.claudeCalls().length, callsBefore, 'rollback does not touch the Claude registration')
  assert.equal(readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8'), codexBefore)

  const sha3 = commitChange(world.source, 'skills/codex-review/SKILL.md', `${original}\nrelease-three\n`)
  assert.equal(A.run(['--source', world.source, '--skip-kit-tests']).status, 0)
  const sha4 = commitChange(world.source, 'skills/codex-review/SKILL.md', `${original}\nrelease-four\n`)
  r = A.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`pruned release ${SHA1}`))
  assert.deepEqual(readdirSync(A.kit('releases')).sort(), [sha2, sha3, sha4].sort())

  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readLink(A.kit('current')), currentTarget(A.home, sha3))
  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readLink(A.kit('current')), currentTarget(A.home, sha2), 'a second rollback goes further back, it does not toggle')
  r = A.run(['--rollback'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no earlier release/)
})

test('rollback to a release that predates rules/orchestration.md keeps the installed rule instead of failing', () => {
  const W = makeWorld('rule-rollback')
  const src = makeSource('rule-rollback')
  const sha1 = shaOf(src)
  let r = W.run(['--source', src, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  // A release built before the rule joined the kit. The installer refuses to
  // BUILD one now (REQUIRED_PATHS), but such releases already sit on disk.
  rmSync(W.kit('releases', sha1, 'rules'), { recursive: true, force: true })
  const original = readFileSync(join(src, 'rules', 'orchestration.md'), 'utf8')
  const sha2 = commitChange(src, 'rules/orchestration.md', `${original}\nrelease-two rule\n`)
  r = W.run(['--source', src, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  const rule = join(W.home, '.claude', 'rules', 'orchestration.md')
  assert.match(readFileSync(rule, 'utf8'), /release-two rule/)

  r = W.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`rolled back: ${sha2} -> ${sha1}`))
  assert.equal(readLink(W.kit('current')), currentTarget(W.home, sha1))
  assert.match(readFileSync(rule, 'utf8'), /release-two rule/, 'the rule survives a rollback to a release without one')
  if (!IS_WINDOWS) assert.match(r.stdout, /kept .*orchestration\.md as it is: rules\/orchestration\.md does not exist in this release/)
})

