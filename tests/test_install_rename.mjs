// The kit was called agent-kit until 01.10.2026. A machine installed under the old name must move on the next
// install: ~/.agent-kit becomes ~/.agent-collab-kit (a link left at the old path), and everything the old name
// registered — Claude's hooks and MCP entry, Codex's config, hooks and AGENTS.md block, the collab launcher — is
// rewritten in place, never duplicated, never refused as foreign. A second install changes nothing.
//
// The old machine is made by installing under the new name and then writing everything back under the old one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, IS_WINDOWS, makeWorld, makeSource, commitChange, mutating } from './helpers/install-world.mjs'

const world = setup()
const skip = IS_WINDOWS

// The managed block's markers exactly as the old installer wrote them.
const NEW_BEGIN = '<!-- agent-collab-kit: begin — managed by agent-collab-kit-install; edit ~/agent-collab-kit, not this block -->'
const OLD_BEGIN = '<!-- agent-kit: begin — managed by agent-kit-install; edit ~/agent-kit, not this block -->'
const toOld = (text) => text
  .replaceAll(NEW_BEGIN, OLD_BEGIN)
  .replaceAll('<!-- agent-collab-kit: end -->', '<!-- agent-kit: end -->')
  .replaceAll('.agent-collab-kit', '.agent-kit')
  .replaceAll('agent-collab-kit-hook', 'agent-kit-hook')

function rewriteOld(file) {
  if (existsSync(file) && lstatSync(file).isFile()) writeFileSync(file, toOld(readFileSync(file, 'utf8')))
}

// Everything an install under the old name would have left, from an install under the new one.
function makeOld(W) {
  const fresh = join(W.home, '.agent-collab-kit')
  const old = join(W.home, '.agent-kit')
  renameSync(fresh, old)
  for (const name of readdirSync(old)) if (name.endsWith('.json') || name.endsWith('.jsonl')) rewriteOld(join(old, name))
  // A release built before the rename has its hook launcher under the old name.
  for (const release of readdirSync(join(old, 'releases'))) {
    const bin = join(old, 'releases', release, 'bin')
    if (existsSync(join(bin, 'agent-collab-kit-hook'))) renameSync(join(bin, 'agent-collab-kit-hook'), join(bin, 'agent-kit-hook'))
  }
  for (const file of [join(W.home, '.claude', 'settings.json'), join(W.home, '.codex', 'hooks.json'), join(W.home, '.codex', 'AGENTS.md'), join(W.home, '.codex', 'config.toml'), join(W.root, 'claude-state.json')]) rewriteOld(file)
  for (const name of readdirSync(W.bindir)) {
    const link = join(W.bindir, name)
    if (!lstatSync(link).isSymbolicLink()) continue
    const target = readlinkSync(link)
    rmSync(link)
    symlinkSync(toOld(target), link)
  }
}

const occurrences = (text, needle) => text.split(needle).length - 1

test('an install over a machine installed as agent-kit moves it and rewrites what the old name registered', { skip }, () => {
  const W = makeWorld('rename-move')
  const source = makeSource('rename-move')
  let r = W.run(['--source', source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  makeOld(W)
  const settingsBefore = readFileSync(join(W.home, '.claude', 'settings.json'), 'utf8')
  assert.ok(settingsBefore.includes('.agent-kit/current/bin/agent-kit-hook'), 'the old machine is really old')
  assert.ok(readFileSync(join(W.home, '.codex', 'AGENTS.md'), 'utf8').includes(OLD_BEGIN))
  // The update that brings the rename is a different commit than the one installed: a new release, as for real.
  commitChange(source, 'CHANGELOG-rename.md', 'renamed\n')

  // A dry run plans against the old directory and moves nothing.
  r = W.run(['--source', source, '--skip-kit-tests', '--dry-run'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /would move/)
  assert.ok(lstatSync(join(W.home, '.agent-kit')).isDirectory() && !existsSync(join(W.home, '.agent-collab-kit')), 'nothing moved')

  // Rolling back before the move is refused with what to do.
  r = W.run(['--rollback'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /still installed under its old name/)

  r = W.run(['--source', source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /moved .*\.agent-kit -> .*\.agent-collab-kit/)
  const old = join(W.home, '.agent-kit')
  assert.ok(lstatSync(old).isSymbolicLink(), 'a link is left at the old path')
  assert.equal(readlinkSync(old), join(W.home, '.agent-collab-kit'))
  assert.ok(lstatSync(join(W.home, '.agent-collab-kit')).isDirectory())

  const settings = readFileSync(join(W.home, '.claude', 'settings.json'), 'utf8')
  assert.equal(occurrences(settings, '/.agent-kit/'), 0, 'no hook left on the old path')
  assert.equal(occurrences(settings, 'agent-kit-hook'), 0)
  const commands = Object.values(JSON.parse(settings).hooks || {}).flat().flatMap((group) => (group.hooks || []).map((hook) => hook.command))
  for (const hook of ['model-guard', 'push-gate']) {
    assert.equal(commands.filter((command) => command.endsWith(`agent-collab-kit-hook" ${hook}`)).length, 1, `${hook} once, not beside an old copy`)
  }
  const server = join(W.home, '.agent-collab-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  assert.deepEqual(W.claudeState().collab.args, [server], 'the old Claude MCP entry is replaced without --replace-claude')
  assert.ok(mutating(W.claudeCalls()).some((call) => call[0] === 'mcp' && call[1] === 'remove'))
  const agents = readFileSync(join(W.home, '.codex', 'AGENTS.md'), 'utf8')
  assert.equal(occurrences(agents, '<!-- agent-collab-kit: begin'), 1, 'one managed block')
  assert.equal(occurrences(agents, '<!-- agent-kit: begin'), 0, 'the old block is replaced where it stood')
  assert.equal(occurrences(readFileSync(join(W.home, '.codex', 'config.toml'), 'utf8'), '/.agent-kit/'), 0)
  assert.equal(occurrences(readFileSync(join(W.home, '.codex', 'hooks.json'), 'utf8'), '/.agent-kit/'), 0)
  for (const name of readdirSync(W.bindir)) {
    const link = join(W.bindir, name)
    if (lstatSync(link).isSymbolicLink()) assert.equal(readlinkSync(link).includes('/.agent-kit/'), false, `${name} points at the new place`)
  }

  r = W.run(['--source', source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing/, 'a second install has nothing to do')

  // Back to the release from before the rename: refused — its hook launcher has the old name.
  r = W.run(['--rollback'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /predates the rename/)
})

test('a ~/.agent-kit that is not this kit\'s link is never taken for ours', { skip }, () => {
  const W = makeWorld('rename-foreign')
  const foreign = join(W.root, 'foreign')
  mkdirSync(join(foreign, 'current', 'bin'), { recursive: true })
  symlinkSync(foreign, join(W.home, '.agent-kit'))
  // A launcher already in the bindir, pointing through that foreign ~/.agent-kit.
  symlinkSync(join(W.home, '.agent-kit', 'current', 'bin', 'collab'), join(W.bindir, 'collab'))
  const r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.notEqual(r.status, 0, 'refused, not rewritten')
  assert.match(r.all, /not inside/)
})

test('both names present is refused, and nothing is moved', { skip }, () => {
  const W = makeWorld('rename-both')
  let r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  mkdirSync(join(W.home, '.agent-kit'))
  writeFileSync(join(W.home, '.agent-kit', 'history.jsonl'), '')
  r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /both .*\.agent-kit .* and .*\.agent-collab-kit exist/)
  assert.ok(lstatSync(join(W.home, '.agent-kit')).isDirectory(), 'the old one is left alone')
})
