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
    assert.match(run('../escape', w.draft('y.md', NOTE)).stderr, /not something that can be installed here/, 'a name that is a path')
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

const UI_REVIEW = {
  platform: 'ios-simulator',
  project: 'My App.xcodeproj',
  scheme: 'My App',
  bundleId: 'com.example.my-app',
  product: 'My App',
  device: 'iPhone 17 Pro Max',
  appearanceNote: 'The in-app appearance setting must be "system" for the simulator appearance to show.'
}

test('ui-review.json is installed the same way, after a check of every value that reaches a command', () => {
  const w = world()
  try {
    const run = (value, extra = []) => runCli(['notes', 'install', 'ui-review.json', w.draft('ui.json', typeof value === 'string' ? value : JSON.stringify(value)), ...extra], { cwd: w.root, options: w.human })
    const ok = run(UI_REVIEW)
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /installed/)
    assert.deepEqual(JSON.parse(readFileSync(join(w.registryDir, 'my-app', 'ui-review.json'), 'utf8')), UI_REVIEW)

    const refused = (value, pattern, label) => {
      const r = run(value)
      assert.notEqual(r.status, 0, `${label}: ${r.stdout}`)
      assert.match(r.stderr, pattern, label)
      assert.deepEqual(JSON.parse(readFileSync(join(w.registryDir, 'my-app', 'ui-review.json'), 'utf8')), UI_REVIEW, `${label}: the installed file is untouched`)
    }
    refused('{ not json', /not valid JSON/, 'not JSON')
    refused('[1]', /one JSON object/, 'not an object')
    refused({ ...UI_REVIEW, extra: 'x' }, /no field "extra"/, 'an unknown field')
    refused({ ...UI_REVIEW, scheme: 'App; rm -rf ~' }, /"scheme".*not a plain value/, 'shell punctuation in a scheme')
    refused({ ...UI_REVIEW, bundleId: 'com.x$(id)' }, /"bundleId"/, 'a substitution in a bundle id')
    refused({ ...UI_REVIEW, product: '../Other' }, /"product"/, 'a path in a product name')
    refused({ ...UI_REVIEW, project: '/etc/App.xcodeproj' }, /"project"/, 'an absolute project path')
    refused({ ...UI_REVIEW, project: '../x/App.xcodeproj' }, /"project"/, 'a project path that climbs out')
    refused({ ...UI_REVIEW, project: 'notes.txt' }, /"project"/, 'a project that is not an Xcode project')
    refused({ ...UI_REVIEW, device: 'iPhone`id`' }, /"device"/, 'a backtick in a device name')
    refused({ ...UI_REVIEW, device: undefined }, /needs a non-empty string "device"/, 'a missing required field')
    refused({ ...UI_REVIEW, appearanceNote: 'x'.repeat(601) }, /appearanceNote/, 'a long note')
    refused(`{"platform":"ios-simulator","token":"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}`, /GitHub personal access token/, 'a secret')
  } finally {
    w.cleanup()
  }
})

test('another platform needs only its name, and a real project file passes', () => {
  const w = world()
  try {
    const web = runCli(['notes', 'install', 'ui-review.json', w.draft('web.json', '{"platform":"web"}')], { cwd: w.root, options: w.human })
    assert.equal(web.status, 0, web.stdout + web.stderr)
    const real = JSON.stringify({ platform: 'ios-simulator', project: 'Tripix.xcodeproj', scheme: 'Tripix', bundleId: 'com.vahagn.Tripix', product: 'Tripix', device: 'iPhone 17 Pro Max' })
    const r = runCli(['notes', 'install', 'ui-review.json', w.draft('real.json', real)], { cwd: w.root, options: w.human })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const tooBig = runCli(['notes', 'install', 'ui-review.json', w.draft('big.json', `{"platform":"web","appearanceNote":"${'x'.repeat(5000)}"}`)], { cwd: w.root, options: w.human })
    assert.notEqual(tooBig.status, 0)
    assert.match(tooBig.stderr, /a few lines/)
    const agent = runCli(['notes', 'install', 'ui-review.json', w.draft('a.json', '{"platform":"web"}')], { cwd: w.root, env: { COLLAB_AGENT_ID: 'claude' }, options: { registryDir: w.registryDir } })
    assert.equal(agent.status, 3, 'an agent shell is refused for this file as for any')
  } finally {
    w.cleanup()
  }
})
