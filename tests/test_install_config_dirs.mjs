// Several Claude Code config directories in one home.
//
// Shared world and fakes: tests/helpers/install-world.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, lib, NODE, makeSource, commitChange, makeWorld, snapshot } from './helpers/install-world.mjs'

const world = setup()

// ── several Claude Code config directories ─────────────────────────────────
//
// One machine can have several Claude accounts, each with its own config
// directory (CLAUDE_CONFIG_DIR). Measured 2026-09-18: a session reads skills,
// agents and rules only from its own directory, so each needs its own copies.

const accountDir = (world, name) => join(world.home, name)

test('installs into every config directory and registers each one separately', () => {
  const W = makeWorld('multi-dirs')
  const second = accountDir(W, '.claude-account-2')
  const source = makeSource('multi-dirs')
  const r = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', second])
  assert.equal(r.status, 0, r.all)

  const cur = join(W.home, '.agent-kit', 'current')
  for (const dir of [join(W.home, '.claude'), second]) {
    for (const skill of ['codex-review', 'ui-review']) {
      const dest = join(dir, 'skills', skill)
      assert.equal(lstatSync(dest).isSymbolicLink(), false, `${dest} is a real directory`)
      assert.ok(readFileSync(join(dest, 'SKILL.md')).equals(readFileSync(join(cur, 'skills', skill, 'SKILL.md'))), dest)
    }
    for (const agent of ['implementer', 'verifier']) {
      const dest = join(dir, 'agents', `${agent}.md`)
      assert.ok(readFileSync(dest).equals(readFileSync(join(cur, 'agents', `${agent}.md`))), dest)
    }
    const rule = join(dir, 'rules', 'orchestration.md')
    assert.ok(readFileSync(rule).equals(readFileSync(join(cur, 'rules', 'orchestration.md'))), rule)
  }
  // Unrelated files in the primary directory are still untouched.
  assert.equal(readFileSync(join(W.home, '.claude', 'rules', 'my-own-rule.md'), 'utf8'), 'mine\n')

  // One registration per directory, each in that directory's own settings.
  const server = join(W.home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  const expected = { scope: 'user', command: NODE, args: [server], env: { COLLAB_AGENT_ID: 'claude' } }
  assert.deepEqual(W.claudeState().collab, expected, 'primary directory registered')
  assert.deepEqual(W.claudeStateIn('.claude-account-2').collab, expected, 'second directory registered')
  assert.match(r.stdout, /claude \(.*\.claude-account-2\): registered user-scope collab/)

  // model-guard and plan-gate live in each directory's settings.json, not in any project.
  for (const dir of [join(W.home, '.claude'), second]) {
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    const commands = settings.hooks.PreToolUse.flatMap((g) => g.hooks).map((h) => h.command)
    assert.deepEqual(commands, [lib.claudeHookCommand(NODE, cur), lib.claudeHookCommand(NODE, cur, 'plan-gate')], dir)
  }
  const settingsBefore = readFileSync(join(second, 'settings.json'))

  // Running again changes nothing: both directories are already in step.
  const again = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', second])
  assert.equal(again.status, 0, again.all)
  assert.doesNotMatch(again.stdout, /registered user-scope collab/)
  assert.match(r.stdout, /model-guard and plan-gate hooks in/)
  assert.doesNotMatch(again.stdout, /model-guard and plan-gate hooks in/)
  assert.ok(readFileSync(join(second, 'settings.json')).equals(settingsBefore), 'settings.json unchanged on a second run')
})

test('CLAUDE_CONFIG_DIR inside the home is picked up; outside it is ignored', () => {
  const W = makeWorld('env-dir')
  const source = makeSource('env-dir')
  const inside = accountDir(W, '.claude-work')
  const r = W.run(['--source', source, '--skip-kit-tests'], { CLAUDE_CONFIG_DIR: inside })
  assert.equal(r.status, 0, r.all)
  assert.ok(existsSync(join(inside, 'rules', 'orchestration.md')), 'directory from the environment is installed into')

  const outside = join(world.base, 'somebody-elses-home', '.claude')
  const r2 = W.run(['--source', source, '--skip-kit-tests'], { CLAUDE_CONFIG_DIR: outside })
  assert.equal(r2.status, 0, r2.all)
  assert.equal(existsSync(outside), false, 'a directory outside the home is not written to')

  // Asked for explicitly, though, an outside directory is an error, not a silence.
  const r3 = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', outside])
  assert.notEqual(r3.status, 0)
  assert.match(r3.stderr, /outside .*home/)
})

test('a foreign file in any config directory is refused, and nothing is installed', () => {
  const W = makeWorld('foreign-second')
  const second = accountDir(W, '.claude-account-2')
  mkdirSync(join(second, 'agents'), { recursive: true })
  writeFileSync(join(second, 'agents', 'verifier.md'), 'hand-written, keep me\n')
  const before = W.snapshot()
  const r = W.run(['--source', makeSource('foreign-second'), '--skip-kit-tests', '--claude-config-dir', second])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /was not created by this installer/)
  assert.match(r.stderr, /\.claude-account-2/)
  assert.equal(readFileSync(join(second, 'agents', 'verifier.md'), 'utf8'), 'hand-written, keep me\n')
  assert.deepEqual(W.snapshot(), before)
})

test('rollback takes every config directory back, not just the first', () => {
  const W = makeWorld('rollback-dirs')
  const second = accountDir(W, '.claude-account-2')
  const source = makeSource('rollback-dirs')
  const args = ['--skip-kit-tests', '--claude-config-dir', second]
  assert.equal(W.run(['--source', source, ...args]).status, 0)
  const ruleV1 = readFileSync(join(second, 'rules', 'orchestration.md'), 'utf8')

  commitChange(source, 'rules/orchestration.md', 'rule v2\n')
  assert.equal(W.run(['--source', source, ...args]).status, 0)
  for (const dir of [join(W.home, '.claude'), second]) {
    assert.equal(readFileSync(join(dir, 'rules', 'orchestration.md'), 'utf8'), 'rule v2\n', dir)
  }

  const back = W.run(['--rollback', ...args])
  assert.equal(back.status, 0, back.all)
  for (const dir of [join(W.home, '.claude'), second]) {
    assert.equal(readFileSync(join(dir, 'rules', 'orchestration.md'), 'utf8'), ruleV1, `${dir} is back on the previous release`)
  }
})

test('a config directory whose Claude cannot run is reported, and the install still completes', () => {
  const W = makeWorld('disabled-account')
  const second = accountDir(W, '.claude-account-2')
  const r = W.run(['--source', makeSource('disabled-account'), '--skip-kit-tests', '--claude-config-dir', second], {
    FAKE_CLAUDE_FAIL_DIR: second
  })
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /claude \(.*\.claude-account-2\): NOT registered/)
  assert.match(r.stdout, /disabled Claude subscription access/)
  // The copies — what a session actually reads — are in place in both directories.
  for (const dir of [join(W.home, '.claude'), second]) {
    assert.ok(existsSync(join(dir, 'rules', 'orchestration.md')), dir)
    assert.ok(existsSync(join(dir, 'agents', 'verifier.md')), dir)
  }
  assert.ok(W.claudeState().collab, 'the working account is still registered')
  assert.deepEqual(W.claudeStateIn('.claude-account-2'), {}, 'the disabled one is not')
})

test('a config directory whose settings are a symlink out of the home is refused', () => {
  const W = makeWorld('symlink-escape')
  const outside = join(world.base, 'outside-home-claude')
  mkdirSync(outside, { recursive: true })
  const link = join(W.home, '.claude-elsewhere')
  symlinkSync(outside, link, 'dir')
  const r = W.run(['--source', makeSource('symlink-escape'), '--skip-kit-tests', '--claude-config-dir', link])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /outside .*home/)
  assert.equal(existsSync(join(outside, 'rules')), false, 'nothing was written through the symlink')
})

test('a failed registration in an extra directory is reported; in the primary one it is still fatal', () => {
  const W = makeWorld('add-fails-second')
  const second = accountDir(W, '.claude-account-2')
  const source = makeSource('add-fails-second')
  const r = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', second], { FAKE_CLAUDE_FAIL_ADD_DIR: second })
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /claude \(.*\.claude-account-2\): NOT registered/)
  assert.ok(W.claudeState().collab, 'the primary account is registered')
  assert.ok(existsSync(join(second, 'rules', 'orchestration.md')), 'copies are installed anyway')

  // The primary directory keeps the old contract: a failed add undoes the install.
  const V = makeWorld('add-fails-primary')
  const before = V.snapshot()
  const bad = V.run(['--source', makeSource('add-fails-primary'), '--skip-kit-tests'], { FAKE_CLAUDE_FAIL_ADD: '1' })
  assert.notEqual(bad.status, 0)
  assert.deepEqual(V.snapshot(), before)
})

test('the default config directory is checked too: a ~/.claude symlinked out of the home is refused', () => {
  const W = makeWorld('default-symlink')
  const outside = join(world.base, 'outside-default-claude')
  mkdirSync(outside, { recursive: true })
  rmSync(join(W.home, '.claude'), { recursive: true, force: true })
  symlinkSync(outside, join(W.home, '.claude'), 'dir')
  const r = W.run(['--source', makeSource('default-symlink'), '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /resolves outside/)
  assert.equal(existsSync(join(outside, 'rules')), false, 'nothing was written through the symlink')
})

test('two spellings of one config directory are installed into once', () => {
  const W = makeWorld('alias-dir')
  const alias = join(W.home, '.claude-alias')
  symlinkSync(join(W.home, '.claude'), alias, 'dir')
  const source = makeSource('alias-dir')
  const r = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', alias])
  assert.equal(r.status, 0, r.all)
  // The alias resolves to the primary directory, so the wording stays the short one
  // and the copy manifest has one key per destination, not two.
  assert.doesNotMatch(r.stdout, /claude \(/)
  const manifest = JSON.parse(readFileSync(W.kit('posix-copies.json'), 'utf8'))
  assert.equal(Object.keys(manifest).filter((k) => k.includes('.claude-alias')).length, 0)
  const again = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', alias])
  assert.equal(again.status, 0, again.all)
  assert.match(again.stdout, /changed: nothing/)
})

test('a failed replace in an extra directory is fatal: the old registration is not silently lost', () => {
  const W = makeWorld('replace-fails-second')
  const second = accountDir(W, '.claude-account-2')
  const stale = { collab: { scope: 'user', command: '/somewhere/node', args: ['/old/server.mjs'], env: { COLLAB_AGENT_ID: 'claude' } } }
  writeFileSync(join(W.root, 'claude-state-.claude-account-2.json'), JSON.stringify(stale))
  const r = W.run(['--source', makeSource('replace-fails-second'), '--skip-kit-tests', '--replace-claude', '--claude-config-dir', second], {
    FAKE_CLAUDE_FAIL_ADD_DIR: second
  })
  assert.notEqual(r.status, 0, 'a half-done replace must not be reported as a warning')
  assert.deepEqual(JSON.parse(readFileSync(join(W.root, 'claude-state-.claude-account-2.json'), 'utf8')), stale, 'the previous registration is back')
})

test('the config-directory boundary is re-checked before writing, not only when the run starts', () => {
  const root = join(world.base, 'toctou')
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const swapped = join(home, '.claude-account-2')
  mkdirSync(swapped)
  const ctx = { home, claudeDirs: lib.resolveClaudeConfigDirs({ claudeConfigDirs: [swapped] }, home) }
  assert.deepEqual(ctx.claudeDirs, [join(home, '.claude'), swapped])
  lib.assertConfigDirsInside(ctx) // still inside: no complaint

  // The directory is swapped for a symlink out of the home after the check.
  rmSync(swapped, { recursive: true, force: true })
  symlinkSync(outside, swapped, 'dir')
  assert.throws(() => lib.assertConfigDirsInside(ctx), /moved while installing|outside/)
})

