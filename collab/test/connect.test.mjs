// `collab connect` / `collab disconnect`: any project goes under the kit from
// what it shows, the person connecting sees the proposal, and only a person at
// a terminal can write the entry — it grants agents rights.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensurePersistentRegistry, proposeConnection, writeConnection } from '../src/connect.mjs'
import { defaultRegistryDir } from '../src/paths.mjs'
import { git, gitRepo, linkForTest, runCli, tempDir } from './helpers.mjs'

function project(base, name, { apple = false, gate = false } = {}) {
  const root = gitRepo(join(base, name), { commit: false })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.js'), 'x\n')
  writeFileSync(join(root, 'README.md'), '# r\n')
  mkdirSync(join(root, '.github'), { recursive: true })
  writeFileSync(join(root, '.github', 'ci.yml'), 'x\n')
  if (apple) {
    mkdirSync(join(root, 'App.xcodeproj'), { recursive: true })
    writeFileSync(join(root, 'App.xcodeproj', 'project.pbxproj'), 'x\n')
  }
  if (gate) {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'preflight.sh'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(root, 'scripts', 'preflight.sh'), 0o755)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init'])
  return realpathSync(root)
}

const world = () => {
  const base = tempDir('collab-connect-')
  const registryDir = join(base, 'registry')
  mkdirSync(registryDir)
  return { base, registryDir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}
const human = (registryDir) => ({ registryDir, assumeHuman: true })
const entries = (registryDir) => readdirSync(registryDir).filter((n) => !n.startsWith('.'))

test('dry run shows the proposal from what the project tracks, and writes nothing', () => {
  const w = world()
  try {
    const root = project(w.base, 'my-app', { apple: true, gate: true })
    const r = runCli(['connect', '--dry-run'], { cwd: root, options: { registryDir: w.registryDir } })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /connect .* as project "my-app"/)
    assert.match(r.stdout, /may write to: App\.xcodeproj\/ README\.md scripts\/ src\//)
    assert.doesNotMatch(r.stdout, /\.github/, 'hidden top-level entries are not proposed')
    assert.match(r.stdout, /platform commands: apple/)
    assert.match(r.stdout, /gate +scripts\/preflight\.sh/)
    assert.deepEqual(entries(w.registryDir), [])
    assert.equal(existsSync(join(root, '.collab')), false)
  } finally {
    w.cleanup()
  }
})

test('only a person at a terminal can connect or disconnect: an agent shell and a non-terminal are refused', () => {
  const w = world()
  try {
    const root = project(w.base, 'my-app')
    const noTty = runCli(['connect'], { cwd: root, options: { registryDir: w.registryDir } })
    assert.equal(noTty.status, 3, noTty.stdout + noTty.stderr)
    assert.match(noTty.stderr, /interactive terminal/)
    const agent = runCli(['connect'], { cwd: root, env: { COLLAB_AGENT_ID: 'codex' }, options: { registryDir: w.registryDir } })
    assert.equal(agent.status, 3)
    assert.match(agent.stderr, /agent's shell/)
    assert.deepEqual(entries(w.registryDir), [], 'nothing written by a refused connect')

    assert.equal(runCli(['connect'], { cwd: root, options: human(w.registryDir) }).status, 0)
    const off = runCli(['disconnect'], { cwd: root, options: { registryDir: w.registryDir } })
    assert.equal(off.status, 3)
    assert.deepEqual(entries(w.registryDir), ['my-app'], 'a refused disconnect removes nothing')
  } finally {
    w.cleanup()
  }
})

test('connect writes the entry and the journal; the project is then found by its path', () => {
  const w = world()
  try {
    const root = project(w.base, 'my-app', { apple: true, gate: true })
    const r = runCli(['connect'], { cwd: root, options: human(w.registryDir) })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const dir = join(w.registryDir, 'my-app')
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')), { id: 'my-app', roots: [root], gate: 'scripts/preflight.sh' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'scopes.json'), 'utf8')), {
      implementer: { allow: ['App.xcodeproj/', 'README.md', 'scripts/', 'src/'], deny: [] }
    })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'readonly-guard.json'), 'utf8')), { platforms: ['apple'] })
    assert.ok(existsSync(join(root, '.collab', 'journal.json')), 'journal created')

    const found = JSON.parse(runCli(['project', '--json'], { cwd: join(root, 'src'), options: { registryDir: w.registryDir } }).stdout)
    assert.equal(found.projectId, 'my-app')

    const again = runCli(['connect'], { cwd: root, options: human(w.registryDir) })
    assert.equal(again.status, 0)
    assert.match(again.stdout, /already connected as "my-app"/)
  } finally {
    w.cleanup()
  }
})

test('no Xcode project, no platform file; a taken id is refused and --id picks another', () => {
  const w = world()
  try {
    const first = project(join(w.base, 'a'), 'my-app')
    const second = project(join(w.base, 'b'), 'my-app')
    assert.equal(runCli(['connect'], { cwd: first, options: human(w.registryDir) }).status, 0)
    assert.equal(existsSync(join(w.registryDir, 'my-app', 'readonly-guard.json')), false)

    const taken = runCli(['connect'], { cwd: second, options: human(w.registryDir) })
    assert.equal(taken.status, 1)
    assert.match(taken.stdout, /already used by another project/)
    assert.equal(runCli(['connect', '--id', 'my-app-two'], { cwd: second, options: human(w.registryDir) }).status, 0)
    assert.deepEqual(entries(w.registryDir).sort(), ['my-app', 'my-app-two'])
  } finally {
    w.cleanup()
  }
})

test('disconnect removes the entry and keeps the journal', () => {
  const w = world()
  try {
    const root = project(w.base, 'my-app')
    assert.equal(runCli(['connect'], { cwd: root, options: human(w.registryDir) }).status, 0)
    const r = runCli(['disconnect'], { cwd: root, options: human(w.registryDir) })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(entries(w.registryDir), [])
    assert.ok(existsSync(join(root, '.collab', 'journal.json')), 'the journal is never touched')
    const found = JSON.parse(runCli(['project', '--json'], { cwd: root, options: { registryDir: w.registryDir } }).stdout)
    assert.equal(found.projectId, null)
    assert.match(runCli(['disconnect'], { cwd: root, options: human(w.registryDir) }).stdout, /not connected/)
  } finally {
    w.cleanup()
  }
})

test('the first persistent registry brings valid release entries along, skips broken ones and symlinks, once', () => {
  const w = world()
  try {
    const release = join(w.base, 'release-projects')
    mkdirSync(join(release, 'old-app'), { recursive: true })
    writeFileSync(join(release, 'old-app', 'project.json'), '{"id":"old-app","roots":["/x"]}\n')
    mkdirSync(join(release, 'broken'), { recursive: true })
    writeFileSync(join(release, 'broken', 'project.json'), '{"id":"not-broken","roots":["/y"]}\n')
    const elsewhere = join(w.base, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'project.json'), '{"id":"linked","roots":["/z"]}\n')
    linkForTest(elsewhere, join(release, 'linked'))
    writeFileSync(join(release, 'README.md'), 'readme\n')
    const persistent = join(w.base, 'persistent')
    assert.deepEqual(ensurePersistentRegistry({ persistent, release }), { created: true, copied: ['old-app'], skipped: ['broken'] })
    assert.deepEqual(readdirSync(persistent), ['old-app'])
    assert.deepEqual(ensurePersistentRegistry({ persistent, release }), { created: false, copied: [], skipped: [] }, 'only once')
  } finally {
    w.cleanup()
  }
})

test('the registry location is decided at every call, not once per process', () => {
  const w = world()
  try {
    const persistent = join(w.base, 'persistent')
    const release = join(w.base, 'release')
    assert.equal(defaultRegistryDir({ persistent, release }), release)
    mkdirSync(persistent)
    assert.equal(defaultRegistryDir({ persistent, release }), persistent)
  } finally {
    w.cleanup()
  }
})

test('a directory without git gets no write scope; a git failure refuses instead of guessing', () => {
  const w = world()
  try {
    const plain = join(w.base, 'plain')
    mkdirSync(join(plain, 'node_modules'), { recursive: true })
    mkdirSync(join(plain, 'src'))
    const r = runCli(['connect'], { cwd: plain, options: human(w.registryDir) })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /not a git repository/)
    assert.deepEqual(JSON.parse(readFileSync(join(w.registryDir, 'plain', 'scopes.json'), 'utf8')), { implementer: { allow: [], deny: [] } })

    const broken = project(w.base, 'broken-git')
    writeFileSync(join(broken, '.git', 'index'), 'not an index')
    const f = runCli(['connect'], { cwd: broken, options: human(w.registryDir) })
    assert.equal(f.status, 1, f.stdout + f.stderr)
    assert.match(f.stderr, /cannot list what git tracks/)
    assert.equal(existsSync(join(w.registryDir, 'broken-git')), false, 'nothing written')
  } finally {
    w.cleanup()
  }
})

test('a symlinked registry entry is ignored, and an id that appears meanwhile is not overwritten', () => {
  const w = world()
  try {
    const root = project(w.base, 'my-app')
    const outside = join(w.base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'project.json'), JSON.stringify({ id: 'my-app', roots: [root] }))
    linkForTest(outside, join(w.registryDir, 'my-app'))
    const found = JSON.parse(runCli(['project', '--json'], { cwd: root, options: { registryDir: w.registryDir } }).stdout)
    assert.equal(found.projectId, null, 'a symlinked entry is not trusted')
    rmSync(join(w.registryDir, 'my-app'))

    const proposal = proposeConnection({ journalRoot: root, registryDir: w.registryDir })
    assert.ok(proposal.ok)
    mkdirSync(join(w.registryDir, 'my-app', 'collab'), { recursive: true })
    writeFileSync(join(w.registryDir, 'my-app', 'collab', 'runners.json'), '{"theirs":true}\n')
    assert.throws(() => writeConnection(proposal, { registryDir: w.registryDir }), /appeared in the registry meanwhile/)
    assert.deepEqual(readdirSync(join(w.registryDir, 'my-app')), ['collab'], 'their entry is left exactly as it was')
  } finally {
    w.cleanup()
  }
})
