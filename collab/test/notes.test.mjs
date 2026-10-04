// `collab notes install`: the one way a project's notes for a skill reach the registry. Notes are instructions an agent
// obeys, so an agent drafts and a person at a terminal installs — after seeing what would change.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { lineChanges, planNoteInstall, NOTE_SKILLS } from '../src/notes.mjs'
import { gitRepo, git, linkForTest, runCli, tempDir } from './helpers.mjs'

function world() {
  const base = tempDir('collab-notes-')
  const registryDir = join(base, 'registry')
  mkdirSync(registryDir)
  const root = gitRepo(join(base, 'my-app'), { commit: false })
  writeFileSync(join(root, 'README.md'), '# r\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init'])
  const home = { registryDir, assumeHuman: true }
  const connected = runCli(['connect'], { cwd: realpathSync(root), options: home })
  assert.equal(connected.status, 0, connected.stdout + connected.stderr)
  const draft = (name, text) => {
    const file = join(base, name)
    writeFileSync(file, text)
    return file
  }
  return { base, registryDir, root: realpathSync(root), draft, human: home, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

const NOTE = '# verify — notes\n\n- Gate: `scripts/check.sh`\n- Build: `make build`\n'

test('a person installs a drafted note; the registry gets exactly the draft', () => {
  const w = world()
  try {
    const file = w.draft('verify.md', NOTE)
    const r = runCli(['notes', 'install', 'verify', file], { cwd: w.root, options: w.human })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /new file/)
    assert.match(r.stdout, /installed/)
    assert.equal(readFileSync(join(w.registryDir, 'my-app', 'verify.md'), 'utf8'), NOTE)
    assert.deepEqual(readdirSync(join(w.registryDir, 'my-app')).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left')

    const again = runCli(['notes', 'install', 'verify', file], { cwd: w.root, options: w.human })
    assert.equal(again.status, 0)
    assert.match(again.stdout, /identical to what is installed/)
    assert.match(again.stdout, /nothing to do/)
  } finally {
    w.cleanup()
  }
})

test('a replacement shows what it adds and drops before it is written', () => {
  const w = world()
  try {
    runCli(['notes', 'install', 'verify', w.draft('a.md', NOTE)], { cwd: w.root, options: w.human })
    const changed = NOTE.replace('make build', 'xcodebuild build')
    const dry = runCli(['notes', 'install', 'verify', w.draft('b.md', changed), '--dry-run'], { cwd: w.root, options: { registryDir: w.registryDir } })
    assert.equal(dry.status, 0, dry.stdout + dry.stderr)
    assert.match(dry.stdout, /replaces the installed note: \+1 \/ -1 lines/)
    assert.match(dry.stdout, /- - Build: `make build`/)
    assert.match(dry.stdout, /\+ - Build: `xcodebuild build`/)
    assert.equal(readFileSync(join(w.registryDir, 'my-app', 'verify.md'), 'utf8'), NOTE, 'a dry run writes nothing')
  } finally {
    w.cleanup()
  }
})

test('an agent shell and a non-terminal are refused, and nothing is written', () => {
  const w = world()
  try {
    const file = w.draft('verify.md', NOTE)
    const target = join(w.registryDir, 'my-app', 'verify.md')
    const noTty = runCli(['notes', 'install', 'verify', file], { cwd: w.root, options: { registryDir: w.registryDir } })
    assert.equal(noTty.status, 3, noTty.stdout + noTty.stderr)
    assert.match(noTty.stderr, /interactive terminal/)
    const agent = runCli(['notes', 'install', 'verify', file], { cwd: w.root, env: { COLLAB_AGENT_ID: 'codex' }, options: { registryDir: w.registryDir } })
    assert.equal(agent.status, 3)
    assert.match(agent.stderr, /agent's shell/)
    assert.equal(existsSync(target), false, 'a refused install writes nothing')
  } finally {
    w.cleanup()
  }
})

test('what is not a plain note for a known skill is refused', () => {
  const w = world()
  try {
    const run = (skill, file) => runCli(['notes', 'install', skill, file], { cwd: w.root, options: w.human })
    assert.notEqual(run('nonsense', w.draft('x.md', NOTE)).status, 0, 'a skill nobody reads notes for')
    assert.match(run('../escape', w.draft('y.md', NOTE)).stderr, /no project notes/, 'a name that is a path')
    assert.notEqual(run('verify', join(w.base, 'missing.md')).status, 0, 'a draft that does not exist')
    assert.notEqual(run('verify', w.draft('empty.md', '')).status, 0, 'an empty draft')
    assert.notEqual(run('verify', w.draft('big.md', 'x'.repeat(70_000))).status, 0, 'an oversized draft')
    assert.notEqual(run('verify', w.draft('bin.md', 'a\0b')).status, 0, 'a binary draft')
    const secret = run('verify', w.draft('secret.md', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'))
    assert.notEqual(secret.status, 0)
    assert.match(secret.stderr, /GitHub personal access token/)
    const link = join(w.base, 'link.md')
    if (linkForTest(w.draft('real.md', NOTE), link)) assert.match(run('verify', link).stderr, /regular file/, 'a link is not followed')
    assert.deepEqual(readdirSync(join(w.registryDir, 'my-app')).filter((n) => n.endsWith('.md')), [], 'none of them installed anything')
  } finally {
    w.cleanup()
  }
})

test('a folder that is not a connected project is refused, and --project names one from anywhere', () => {
  const w = world()
  try {
    const elsewhere = tempDir('collab-notes-elsewhere-')
    try {
      const file = w.draft('verify.md', NOTE)
      const lost = runCli(['notes', 'install', 'verify', file], { cwd: elsewhere, options: w.human })
      assert.notEqual(lost.status, 0)
      assert.match(lost.stderr, /not a connected project/)
      const named = runCli(['notes', 'install', 'verify', file, '--project', 'my-app'], { cwd: elsewhere, options: w.human })
      assert.equal(named.status, 0, named.stdout + named.stderr)
      assert.equal(readFileSync(join(w.registryDir, 'my-app', 'verify.md'), 'utf8'), NOTE)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  } finally {
    w.cleanup()
  }
})

test('line changes count additions and removals as a multiset', () => {
  assert.deepEqual(lineChanges('a\nb\nb', 'a\nb\nc'), { added: ['c'], removed: ['b'] })
  assert.deepEqual(lineChanges('x', 'x'), { added: [], removed: [] })
  assert.ok(NOTE_SKILLS.includes('verify') && !NOTE_SKILLS.includes('ui-review'))
  assert.throws(() => planNoteInstall({ projectDir: '/nope', skill: 'verify', file: null }), /name the draft file/)
})
