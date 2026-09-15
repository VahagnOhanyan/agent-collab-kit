// Tests for bin/agent-kit-install. Run: node --test tests/test_install.mjs
//
// Every test builds its own world in a temp directory: a temp HOME, a temp
// bindir, a fake `claude` and a fake `codex` that record their argv, and a temp
// source git repository made from a file copy of ~/agent-kit (never modified).
// Nothing here touches the real ~/.agent-kit, ~/.claude, ~/.codex or bindir.
//
// Only two installs run the kit's own test suite (about a minute each): the
// clean install, and the one proving a failing kit test refuses the install.
// Every other install passes the hidden --skip-kit-tests; the smoke test
// (check-config + MCP handshake) still runs in all of them.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, '..', 'bin', 'agent-kit-install')
const KIT = process.env.AGENT_KIT_TEST_SOURCE || join(homedir(), 'agent-kit')
const lib = createRequire(import.meta.url)(INSTALLER)
// What both registrations must use on this machine (independent of the installer's own resolution).
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? lib.resolveNode().path

let BASE
let TEMPLATE
let SOURCE // shared clean source repo

const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git'].find(existsSync)
function git(cwd, args) {
  const r = spawnSync(GIT, ['-c', 'user.name=installer-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...cleanEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('COLLAB_') || k.startsWith('GIT_') || k === 'NODE_TEST_CONTEXT' || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  return env
}

function makeSource(name, mutate) {
  const dir = join(BASE, `src-${name}`)
  cpSync(TEMPLATE, dir, { recursive: true, verbatimSymlinks: true })
  mutate?.(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'kit snapshot'])
  return dir
}

function commitChange(dir, rel, content) {
  writeFileSync(join(dir, rel), content)
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', `change ${rel}`])
  return git(dir, ['rev-parse', 'HEAD']).slice(0, 12)
}

const shaOf = (dir) => git(dir, ['rev-parse', 'HEAD']).slice(0, 12)

const FAKE_CLAUDE = `
const fs = require('fs')
const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\\n')
const file = process.env.FAKE_CLAUDE_STATE
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2))
const labels = { user: 'User config (available in all your projects)', project: 'Project config (shared via .mcp.json)', local: 'Local config (private to you in this project)' }
const [group, sub, ...rest] = argv
if (group !== 'mcp') { console.error('fake claude: only mcp'); process.exit(2) }
const positional = []
const env = {}
let scope = 'local'
let i = 0
for (; i < rest.length; i++) {
  if (rest[i] === '--') { i++; break }
  if (rest[i] === '-s') scope = rest[++i]
  else if (rest[i] === '-e') { const [k, ...v] = rest[++i].split('='); env[k] = v.join('=') }
  else positional.push(rest[i])
}
const name = positional[0]
if (sub === 'get') {
  const s = state[name]
  // Claude Code 2.1.270: not found prints this and exits 0.
  if (!s) { console.log('No MCP server named "' + name + '". Configured servers: claude.ai Google Drive'); process.exit(0) }
  const out = [name + ':', '  Scope: ' + labels[s.scope], '  Status: \\u2714 Connected', '  Type: stdio', '  Command: ' + s.command, '  Args: ' + s.args.join(' ')]
  if (Object.keys(s.env).length) { out.push('  Environment:'); for (const [k, v] of Object.entries(s.env)) out.push('    ' + k + '=' + v) }
  out.push('', 'To remove this server, run: claude mcp remove ' + name + ' -s ' + s.scope)
  console.log(out.join('\\n'))
} else if (sub === 'add') {
  if (process.env.FAKE_CLAUDE_FAIL_ADD) { console.error('fake claude: add failed on purpose'); process.exit(1) }
  if (state[name]) { console.error('MCP server ' + name + ' already exists'); process.exit(1) }
  const [command, ...args] = rest.slice(i)
  state[name] = { scope, command, args, env }
  save()
  console.log('Added stdio MCP server ' + name + ' to ' + scope + ' config')
} else if (sub === 'remove') {
  if (!state[name] || state[name].scope !== scope) { console.error('No ' + scope + '-scoped MCP server found with name: ' + name); process.exit(1) }
  delete state[name]
  save()
  console.log('Removed MCP server ' + name)
} else { console.error('fake claude: unsupported ' + sub); process.exit(2) }
`

const FAKE_CODEX = `
require('fs').appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
`

const CODEX_FIXTURE = `# Codex settings (test fixture) — keep me
model = "gpt-5"

[profiles.fast]
model = "gpt-5-mini"   # inline comment

[mcp_servers.other]
command = "other"
args = [
  "--flag",
  "[not-a-header]",
]
`

function makeWorld(name, { codex = CODEX_FIXTURE, claudeState = null } = {}) {
  const root = join(BASE, `world-${name}`)
  const home = join(root, 'home')
  const bindir = join(root, 'bin')
  const fakebin = join(root, 'fakebin')
  for (const d of [home, bindir, fakebin]) mkdirSync(d, { recursive: true })
  const claude = join(fakebin, 'claude')
  writeFileSync(claude, `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o755 })
  writeFileSync(join(fakebin, 'codex'), `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 })
  const claudeLog = join(root, 'claude-argv.jsonl')
  const claudeStateFile = join(root, 'claude-state.json')
  const codexLog = join(root, 'codex-argv.jsonl')
  if (claudeState) writeFileSync(claudeStateFile, JSON.stringify(claudeState))
  if (codex !== null) {
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), codex)
  }
  // An unrelated user skill that must survive everything.
  mkdirSync(join(home, '.claude', 'skills', 'my-own-skill'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), 'mine\n')

  const env = {
    ...cleanEnv(),
    PATH: `${fakebin}:${process.env.PATH}`,
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CLAUDE_STATE: claudeStateFile,
    FAKE_CODEX_LOG: codexLog
  }
  return {
    root,
    home,
    bindir,
    run(args, extraEnv = {}) {
      const r = spawnSync(process.execPath, [INSTALLER, '--home', home, '--bindir', bindir, '--claude-bin', claude, ...args], {
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        timeout: 15 * 60 * 1000
      })
      r.all = `${r.stdout}\n${r.stderr}`
      return r
    },
    claudeCalls: () => (existsSync(claudeLog) ? readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    claudeState: () => (existsSync(claudeStateFile) ? JSON.parse(readFileSync(claudeStateFile, 'utf8')) : {}),
    codexCalls: () => (existsSync(codexLog) ? readFileSync(codexLog, 'utf8') : ''),
    snapshot: () => ({ home: snapshot(home), bindir: snapshot(bindir), claude: existsSync(claudeStateFile) ? readFileSync(claudeStateFile, 'utf8') : null }),
    kit: (...p) => join(home, '.agent-kit', ...p),
    history: () => readFileSync(join(home, '.agent-kit', 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }
}

function snapshot(dir) {
  const entries = {}
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(dir, r))
      if (st.isSymbolicLink()) entries[r] = `link:${readlinkSync(join(dir, r))}`
      else if (st.isDirectory()) {
        entries[r] = 'dir'
        walk(r)
      } else entries[r] = `file:${createHash('sha256').update(readFileSync(join(dir, r))).digest('hex')}`
    }
  }
  walk('')
  return entries
}

const mutating = (calls) => calls.filter((argv) => argv[1] === 'add' || argv[1] === 'remove')
const expectedBlock = (home) =>
  [
    '[mcp_servers.collab]',
    '# Managed by agent-kit-install: the active agent-kit release, through ~/.agent-kit/current.',
    `command = "${NODE}"`,
    `args = ["${home}/.agent-kit/current/collab/src/mcp/server.mjs"]`,
    'env = { COLLAB_AGENT_ID = "codex" }',
    'startup_timeout_sec = 20'
  ].join('\n')

before(() => {
  BASE = realpathSync(mkdtempSync(join(tmpdir(), 'agent-kit-install-test-')))
  TEMPLATE = join(BASE, 'template')
  const skip = new Set(['.git', 'node_modules', '.collab', '.DS_Store', '__pycache__'])
  cpSync(KIT, TEMPLATE, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.has(src.split('/').pop()) })
  // ~/agent-kit/agents may still be empty while Ф4 is in progress.
  mkdirSync(join(TEMPLATE, 'agents'), { recursive: true })
  for (const agent of ['implementer', 'verifier']) {
    const file = join(TEMPLATE, 'agents', `${agent}.md`)
    if (!existsSync(file)) writeFileSync(file, `---\nname: ${agent}\ndescription: test stub\n---\n`)
  }
  SOURCE = makeSource('clean')
})

after(() => {
  if (BASE && !process.env.KEEP_TEST_DIRS) rmSync(BASE, { recursive: true, force: true })
})

// ── unit: pure functions ───────────────────────────────────────────────────

test('TAP verdict: requires exit 0, tests > 0, and zero fail/skipped/cancelled', () => {
  const tap = (o) => `TAP version 13\n1..3\n# tests ${o.tests}\n# suites 0\n# pass ${o.pass}\n# fail ${o.fail}\n# cancelled ${o.cancelled}\n# skipped ${o.skipped}\n# todo 0\n`
  const green = { tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0 }
  assert.equal(lib.tapVerdict({ status: 0, stdout: tap(green) }).ok, true)
  assert.equal(lib.tapVerdict({ status: 1, stdout: tap(green) }).ok, false)
  assert.match(lib.tapVerdict({ status: 0, stdout: tap({ ...green, pass: 2, skipped: 1 }) }).problems.join(), /# skipped 1/)
  assert.match(lib.tapVerdict({ status: 0, stdout: tap({ ...green, cancelled: 1 }) }).problems.join(), /# cancelled 1/)
  assert.match(lib.tapVerdict({ status: 0, stdout: tap({ ...green, tests: 0, pass: 0 }) }).problems.join(), /nothing ran/)
  assert.equal(lib.tapVerdict({ status: 0, stdout: 'ok 1 - x\n' }).ok, false)
  // indented subtest summaries do not count, only the top-level one
  assert.equal(lib.tapVerdict({ status: 0, stdout: `    # skipped 0\n${tap({ ...green, skipped: 2 })}` }).ok, false)
})

test('Codex TOML rewrite: replaces only the collab section, bytes elsewhere untouched', () => {
  const block = lib.codexBlock('/h/.agent-kit/current/collab/src/mcp/server.mjs', '/opt/homebrew/bin/node')
  assert.equal(block[2], 'command = "/opt/homebrew/bin/node"')
  const head = '# top — comment\r\nmodel = "gpt-5"\r\n\r\n'
  const old = '[mcp_servers.collab]\r\n# old comment\r\ncommand = "node"\r\nargs = [\r\n  "/old/server.mjs",\r\n]\r\n\r\n[mcp_servers.collab.env]\r\nCOLLAB_AGENT_ID = "codex"\r\n'
  const tailText = '\r\n# belongs to the next table\r\n[mcp_servers.other]\r\ndescription = """\r\n[mcp_servers.collab]\r\n"""\r\n\r\n[mcp_servers.collab_extra]\r\ncommand = "x"'
  const r = lib.rewriteCodexToml(head + old + tailText, block)
  assert.equal(r.changed, true)
  assert.equal(r.text, head + block.join('\r\n') + '\r\n' + tailText)
  assert.equal(lib.rewriteCodexToml(r.text, block).changed, false, 'second pass is a no-op')

  // append: keeps a missing trailing newline's line intact and adds one blank line
  assert.equal(lib.rewriteCodexToml('a = 1', block).text, `a = 1\n\n${block.join('\n')}\n`)
  assert.equal(lib.rewriteCodexToml('a = 1\n\n', block).text, `a = 1\n\n${block.join('\n')}\n`)
  assert.equal(lib.rewriteCodexToml('', block).text, `${block.join('\n')}\n`)

  // definitions the scanner will not rewrite
  assert.throws(() => lib.rewriteCodexToml('[mcp_servers]\ncollab = { command = "node" }\n', block), /defined by the key "collab"/)
  assert.throws(() => lib.rewriteCodexToml('mcp_servers.collab.command = "node"\n', block), /defined by the key/)
  assert.throws(() => lib.rewriteCodexToml('[mcp_servers.collab]\n[x]\n[mcp_servers.collab]\n', block), /second/)
  assert.throws(() => lib.rewriteCodexToml('[mcp_servers.collab.env]\nA = "b"\n', block), /not directly under/)
})

test('claude mcp get parser: real Claude Code 2.x text format', () => {
  const text = [
    'collab:',
    '  Scope: User config (available in all your projects)',
    '  Status: [32m✓[39m Connected',
    '  Type: stdio',
    '  Command: node',
    '  Args: /Users/x/.agent-kit/current/collab/src/mcp/server.mjs',
    '  Environment:',
    '    COLLAB_AGENT_ID=claude',
    '',
    'To remove this server, run: claude mcp remove "collab" -s user'
  ].join('\n')
  const reg = lib.parseClaudeGet({ status: 0, stdout: text, stderr: '' })
  assert.deepEqual(
    { scope: reg.scope, type: reg.type, command: reg.command, args: reg.args, env: reg.env },
    { scope: 'user', type: 'stdio', command: 'node', args: '/Users/x/.agent-kit/current/collab/src/mcp/server.mjs', env: { COLLAB_AGENT_ID: 'claude' } }
  )
  assert.deepEqual(lib.parseClaudeGet({ status: 1, stdout: '', stderr: 'No MCP server found with name: collab' }), { found: false })
  assert.throws(() => lib.parseClaudeGet({ status: 1, stdout: 'boom', stderr: '' }), /could not interpret/)
})

test('claude mcp get parser: formats captured from Claude Code 2.1.270; the exit code is never used', () => {
  const aweiro = [
    'aweiro:',
    '  Scope: Project config (shared via .mcp.json)',
    '  Status: ✔ Connected',
    '  Type: stdio',
    '  Command: node',
    '  Args: backend/mcp/server.js',
    '  Environment:',
    '    AWEIRO_API_BASE_URL=${AWEIRO_API_BASE_URL}',
    '    AWEIRO_SEED_TOKEN=<value>',
    '    AWEIRO_AS_USER=${AWEIRO_AS_USER}',
    '',
    'To remove this server, run: claude mcp remove aweiro -s project'
  ].join('\n')
  const reg = lib.parseClaudeGet({ status: 0, stdout: aweiro, stderr: '' }, 'aweiro')
  assert.equal(reg.found, true)
  assert.equal(reg.scopeLabel, 'Project config (shared via .mcp.json)')
  assert.notEqual(reg.scope, 'user')
  assert.equal(reg.command, 'node')
  assert.equal(reg.args, 'backend/mcp/server.js')
  assert.deepEqual(reg.env, { AWEIRO_API_BASE_URL: '${AWEIRO_API_BASE_URL}', AWEIRO_SEED_TOKEN: '<value>', AWEIRO_AS_USER: '${AWEIRO_AS_USER}' })
  assert.deepEqual(lib.parseClaudeGet({ status: 1, stdout: aweiro, stderr: '' }, 'aweiro'), reg, 'same text, other exit code: same result')

  const notFound = 'No MCP server named "collab". Configured servers: claude.ai Google Drive\n'
  assert.deepEqual(lib.parseClaudeGet({ status: 0, stdout: notFound, stderr: '' }), { found: false })
  assert.throws(() => lib.parseClaudeGet({ status: 0, stdout: aweiro, stderr: '' }), /could not interpret/, 'another server is not "not found"')

  const userish = aweiro.replace('aweiro:', 'collab:').replace('Project config (shared via .mcp.json)', 'user config (some future wording)')
  assert.equal(lib.parseClaudeGet({ status: 0, stdout: userish, stderr: '' }).scope, 'user')
})

test('node for registrations: stable candidate path as-is, else realpath of the PATH node with a warning', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-kit-node-')))
  try {
    const cellar = join(dir, 'Cellar', 'node@20', '20.19.6', 'bin')
    mkdirSync(cellar, { recursive: true })
    const real = join(cellar, 'node')
    writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 })
    const brewBin = join(dir, 'brew-bin')
    mkdirSync(brewBin)
    symlinkSync(real, join(brewBin, 'node'))
    const missing = join(dir, 'missing', 'node')

    assert.deepEqual(lib.resolveNode({ candidates: [missing, join(brewBin, 'node')], pathEnv: '' }), { path: join(brewBin, 'node'), warning: null })
    const viaPath = lib.resolveNode({ candidates: [missing], pathEnv: `relative/dir:${join(dir, 'empty')}:${brewBin}` })
    assert.equal(viaPath.path, real)
    assert.match(viaPath.warning, /realpath of `command -v node`.*may break when Node is upgraded/)
    assert.throws(() => lib.resolveNode({ candidates: [missing], pathEnv: join(dir, 'empty') }), /no node found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool set comparison is exact: same names, same count', () => {
  assert.deepEqual(lib.compareToolNames(['a', 'b'], ['b', 'a']), [])
  assert.match(lib.compareToolNames(['a', 'b'], ['a']).join('; '), /1 tools listed, tools\.mjs defines 2; missing: b/)
  assert.match(lib.compareToolNames(['a'], ['a', 'c']).join('; '), /not in tools\.mjs: c/)
  assert.match(lib.compareToolNames(['a', 'b'], ['a', 'a']).join('; '), /listed twice: a/)
  assert.notDeepEqual(lib.compareToolNames([], []), [])
})

// ── integration ────────────────────────────────────────────────────────────

test('a source missing required agents, skills, hooks or launcher is refused before anything runs', () => {
  const W = makeWorld('layout')
  const partial = makeSource('layout', (dir) => {
    rmSync(join(dir, 'agents'), { recursive: true, force: true })
    rmSync(join(dir, 'hooks', 'scope-guard.py'))
  })
  const before = W.snapshot()
  const r = W.run(['--source', partial, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /is missing required paths:\n {2}- agents\/implementer\.md\n {2}- agents\/verifier\.md\n {2}- hooks\/scope-guard\.py\n/)
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
  const r = W.run(['--source', SOURCE, '--skip-kit-tests', '--replace-claude'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /shows "collab" with Scope: Project config \(shared via \.mcp\.json\)\n/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

let A // the world shared by the install → reinstall → rollback sequence
let SHA1

test('clean install: kit tests green, release activated, links, Claude and Codex registered', () => {
  A = makeWorld('main')
  SHA1 = shaOf(SOURCE)
  const r = A.run(['--source', SOURCE])
  assert.equal(r.status, 0, r.all)

  assert.match(r.stdout, /kit tests: \d+ tests, \d+ pass, 0 fail, 0 skipped, 0 cancelled/)
  assert.match(r.stdout, /smoke: check-config ok; MCP initialize \+ tools\/list = \d+ tools, same names as tools\.mjs; whoami -> NOT_INITIALIZED; nothing created/)
  assert.ok(r.stdout.includes(`node for registrations: ${NODE}\n`), r.stdout)
  assert.match(r.stdout, new RegExp(`installed: ${SHA1}`))
  assert.match(r.stdout, /previous: {2}none/)
  assert.match(r.stdout, /rollback: {2}.*agent-kit-install --rollback/)
  assert.match(r.stdout, /перезапустите открытые сессии Claude, Codex и Gemini/)

  assert.equal(readlinkSync(A.kit('current')), `releases/${SHA1}`)
  assert.ok(existsSync(A.kit('releases', SHA1, 'collab', 'src', 'mcp', 'server.mjs')))
  assert.deepEqual(readdirSync(A.kit('tmp')), [], 'build dir moved away')
  const [entry] = A.history()
  assert.equal(A.history().length, 1)
  assert.equal(entry.sha, SHA1)
  assert.equal(entry.previous, null)
  assert.equal(entry.kit_tests, 'passed')
  assert.ok(!Number.isNaN(Date.parse(entry.at)))

  const cur = A.kit('current')
  assert.equal(readlinkSync(join(A.home, '.claude', 'skills', 'codex-review')), join(cur, 'skills', 'codex-review'))
  assert.equal(readlinkSync(join(A.home, '.claude', 'skills', 'ui-review')), join(cur, 'skills', 'ui-review'))
  assert.equal(readlinkSync(join(A.home, '.claude', 'agents', 'implementer.md')), join(cur, 'agents', 'implementer.md'))
  assert.equal(readlinkSync(join(A.home, '.claude', 'agents', 'verifier.md')), join(cur, 'agents', 'verifier.md'))
  assert.equal(readlinkSync(join(A.bindir, 'collab')), join(cur, 'bin', 'collab'))
  assert.ok(existsSync(join(A.home, '.claude', 'skills', 'codex-review', 'SKILL.md')), 'links resolve')
  assert.ok(existsSync(join(A.home, '.claude', 'skills', 'my-own-skill', 'SKILL.md')), 'unrelated skill kept')
  const launcher = spawnSync(join(A.bindir, 'collab'), ['check-config'], { encoding: 'utf8', env: cleanEnv() })
  assert.equal(launcher.status, 0, launcher.stderr)

  const server = join(A.home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  assert.deepEqual(mutating(A.claudeCalls()), [['mcp', 'add', '-s', 'user', 'collab', '-e', 'COLLAB_AGENT_ID=claude', '--', NODE, server]])
  assert.deepEqual(A.claudeState().collab, { scope: 'user', command: NODE, args: [server], env: { COLLAB_AGENT_ID: 'claude' } })

  const config = readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8')
  assert.equal(config, `${CODEX_FIXTURE}\n${expectedBlock(A.home)}\n`)
  const backups = readdirSync(join(A.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(A.home, '.codex', backups[0]), 'utf8'), CODEX_FIXTURE)
  assert.equal(A.codexCalls(), '', 'codex itself is never run')
  assert.ok(!existsSync(join(A.home, '.agent-kit.lock')))
})

test('reinstalling the same commit changes nothing', () => {
  assert.ok(A, 'depends on the clean install')
  const before = A.snapshot()
  const callsBefore = A.claudeCalls().length
  const r = A.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
  assert.deepEqual(A.snapshot(), before)
  const newCalls = A.claudeCalls().slice(callsBefore)
  assert.ok(newCalls.length > 0 && newCalls.every((argv) => argv[1] === 'get'), JSON.stringify(newCalls))
})

test('rollback switches current and the links follow; repeated rollback walks back; old releases are pruned', () => {
  assert.ok(A, 'depends on the clean install')
  const skill = join(A.home, '.claude', 'skills', 'codex-review', 'SKILL.md')
  const original = readFileSync(join(SOURCE, 'skills', 'codex-review', 'SKILL.md'), 'utf8')
  const sha2 = commitChange(SOURCE, 'skills/codex-review/SKILL.md', `${original}\nrelease-two marker\n`)
  let r = A.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readlinkSync(A.kit('current')), `releases/${sha2}`)
  assert.match(readFileSync(skill, 'utf8'), /release-two marker/)
  assert.match(r.stdout, new RegExp(`previous: {2}${SHA1}`))
  const callsBefore = A.claudeCalls().length
  const codexBefore = readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8')

  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`rolled back: ${sha2} -> ${SHA1}`))
  assert.equal(readlinkSync(A.kit('current')), `releases/${SHA1}`)
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /release-two marker/)
  assert.equal(realpathSync(join(A.bindir, 'collab')), realpathSync(A.kit('releases', SHA1, 'bin', 'collab')))
  assert.deepEqual(A.history().at(-1), { ...A.history().at(-1), sha: SHA1, previous: sha2, action: 'rollback' })
  assert.equal(A.claudeCalls().length, callsBefore, 'rollback does not touch the Claude registration')
  assert.equal(readFileSync(join(A.home, '.codex', 'config.toml'), 'utf8'), codexBefore)

  const sha3 = commitChange(SOURCE, 'skills/codex-review/SKILL.md', `${original}\nrelease-three\n`)
  assert.equal(A.run(['--source', SOURCE, '--skip-kit-tests']).status, 0)
  const sha4 = commitChange(SOURCE, 'skills/codex-review/SKILL.md', `${original}\nrelease-four\n`)
  r = A.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`pruned release ${SHA1}`))
  assert.deepEqual(readdirSync(A.kit('releases')).sort(), [sha2, sha3, sha4].sort())

  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readlinkSync(A.kit('current')), `releases/${sha3}`)
  r = A.run(['--rollback'])
  assert.equal(r.status, 0, r.all)
  assert.equal(readlinkSync(A.kit('current')), `releases/${sha2}`, 'a second rollback goes further back, it does not toggle')
  r = A.run(['--rollback'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no earlier release/)
})

test('a dirty source (or one without commits) is refused and the files are named', () => {
  const W = makeWorld('dirty')
  const dirty = makeSource('dirty')
  appendFileSync(join(dirty, 'bin', 'collab'), '\n// local edit\n')
  writeFileSync(join(dirty, 'untracked.txt'), 'x')
  const before = W.snapshot()
  let r = W.run(['--source', dirty])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /uncommitted changes/)
  assert.match(r.stderr, /bin\/collab/)
  assert.match(r.stderr, /untracked\.txt/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(W.claudeCalls(), [])

  const empty = join(BASE, 'src-empty')
  mkdirSync(empty)
  git(empty, ['init', '-q'])
  r = W.run(['--source', empty])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /has no commits/)
  assert.deepEqual(W.snapshot(), before)
})

test('a failing kit test refuses the install and leaves home unchanged', () => {
  const W = makeWorld('failing')
  const failing = makeSource('failing', (dir) => {
    writeFileSync(
      join(dir, 'collab', 'test', 'zz-injected.test.mjs'),
      "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('injected failure', () => assert.equal(1, 2))\n"
    )
  })
  const before = W.snapshot()
  const r = W.run(['--source', failing])
  assert.notEqual(r.status, 0, r.all)
  assert.match(r.stderr, /kit tests did not pass: .*# fail [1-9]\d*/)
  assert.match(r.stderr, /not ok - injected failure/)
  assert.deepEqual(W.snapshot(), before, 'no .agent-kit, no links, no config change')
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

test('an existing foreign file or symlink at a link destination is refused; nothing changes', () => {
  const W = makeWorld('foreign-link')
  mkdirSync(join(W.home, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(W.home, '.claude', 'agents', 'verifier.md'), 'my own verifier\n')
  symlinkSync('/somewhere/else/collab', join(W.bindir, 'collab'))
  const before = W.snapshot()
  const r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /verifier\.md exists and is a regular file/)
  assert.match(r.stderr, /collab is a symlink to \/somewhere\/else\/collab/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

test('a failure after changes began rolls back everything this run changed', () => {
  const W = makeWorld('mid-failure')
  const before = W.snapshot()
  const r = W.run(['--source', SOURCE, '--skip-kit-tests'], { FAKE_CLAUDE_FAIL_ADD: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /claude mcp add .* failed/)
  assert.match(r.stderr, /this run was rolled back/)
  assert.match(r.stderr, /undone: rewrote .*config\.toml/)
  assert.match(r.stderr, /undone: switched .*current/)
  assert.deepEqual(W.snapshot(), before, 'home, bindir and Claude state exactly as before')
})

test('a different user-scope collab registration is refused without --replace-claude', () => {
  const old = { scope: 'user', command: 'node', args: ['/Users/x/Tripix/tools/collab/src/mcp/server.mjs'], env: { COLLAB_AGENT_ID: 'claude' } }
  const W = makeWorld('foreign-claude', { claudeState: { collab: old } })
  const before = W.snapshot()
  let r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /different user-scope "collab"/)
  assert.match(r.stderr, /Tripix\/tools\/collab/)
  assert.match(r.stderr, /--replace-claude/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])

  r = W.run(['--source', SOURCE, '--skip-kit-tests', '--replace-claude'])
  assert.equal(r.status, 0, r.all)
  const server = join(W.home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  assert.deepEqual(mutating(W.claudeCalls()), [
    ['mcp', 'remove', '-s', 'user', 'collab'],
    ['mcp', 'add', '-s', 'user', 'collab', '-e', 'COLLAB_AGENT_ID=claude', '--', NODE, server]
  ])
  assert.deepEqual(W.claudeState().collab, { scope: 'user', command: NODE, args: [server], env: { COLLAB_AGENT_ID: 'claude' } })
})

test('Codex config: the existing collab block is replaced, everything else byte-identical, backup written', () => {
  const head = '# Codex — personal config\nmodel = "gpt-5"\n\n[projects."/Users/x/Tripix"]\ntrust_level = "trusted"\n\n'
  const oldBlock =
    '[mcp_servers.collab]\n# Aweiro collaboration layer — shared tasks, messages, reviews, decisions and\n# approvals. Managed by tools/collab/codex/install.mjs; see docs/tooling/collab.md.\ncommand = "node"\nargs = ["/Users/x/Tripix/tools/collab/src/mcp/server.mjs"]\nenv = { COLLAB_AGENT_ID = "codex" }\nstartup_timeout_sec = 20\n'
  const rest = '\n# the next table\n[mcp_servers.other]\ncommand = "other"\nnotes = """\n[mcp_servers.collab]\n"""\n'
  const original = head + oldBlock + rest
  const W = makeWorld('codex', { codex: original })
  const r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /codex: replaced \[mcp_servers\.collab\]/)
  assert.match(r.stdout, /replaced codex block was:\n\[mcp_servers\.collab\]\n# Aweiro/)
  const configPath = join(W.home, '.codex', 'config.toml')
  assert.equal(readFileSync(configPath, 'utf8'), `${head}${expectedBlock(W.home)}\n${rest}`)
  const backups = readdirSync(join(W.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(W.home, '.codex', backups[0]), 'utf8'), original)
  assert.equal((lstatSync(configPath).mode & 0o777).toString(8), '644', 'mode kept')

  const again = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(again.status, 0, again.all)
  assert.equal(readdirSync(join(W.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-')).length, 1, 'already correct: no write, no backup')
})

test('dry-run runs the checks and the smoke test but changes nothing', () => {
  const W = makeWorld('dry')
  const before = W.snapshot()
  const r = W.run(['--source', SOURCE, '--skip-kit-tests', '--dry-run'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /smoke: check-config ok; MCP initialize \+ tools\/list = \d+ tools, same names as tools\.mjs/)
  assert.match(r.stdout, /DRY RUN — every check passed; nothing was changed\./)
  assert.match(r.stdout, /planned changes:/)
  assert.match(r.stdout, /current -> releases\//)
  assert.match(r.stdout, /link .*verifier\.md -> .*current\/agents\/verifier\.md \(create\)/)
  assert.match(r.stdout, /codex: append \[mcp_servers\.collab\]/)
  assert.match(r.stdout, /claude: add user-scope collab/)
  assert.deepEqual(W.snapshot(), before)
  assert.ok(W.claudeCalls().every((argv) => argv[1] === 'get'))

  // dry-run refuses the same things a real run refuses
  const dirty = makeSource('dry-dirty')
  writeFileSync(join(dirty, 'new-file'), 'x')
  const refused = W.run(['--source', dirty, '--skip-kit-tests', '--dry-run'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /uncommitted changes/)
  assert.deepEqual(W.snapshot(), before)
})
