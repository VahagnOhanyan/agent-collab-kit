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
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WINDOWS = process.platform === 'win32'
const LAUNCHER_NAME = IS_WINDOWS ? 'collab.cmd' : 'collab'

// Strips the noise a Windows junction's target can read back with (an
// extended-length "\\?\" prefix, a trailing separator) — mirrors
// agent-kit-install's own normaliseLinkTarget, so these tests compare
// like-for-like with what the installer itself considers equal.
function normaliseTarget(raw) {
  if (!IS_WINDOWS) return raw
  let s = raw
  if (s.startsWith('\\\\?\\')) s = s.slice(4)
  if (s.length > 3 && (s.endsWith('\\') || s.endsWith('/'))) s = s.slice(0, -1)
  return s
}
const readLink = (dest) => normaliseTarget(readlinkSync(dest))
// What `current` should point at right now: a relative "releases/<sha>" on
// POSIX, an absolute release path on Windows (junctions need one) — see
// switchCurrent's comment in agent-kit-install.
const currentTarget = (home, sha) => (IS_WINDOWS ? join(home, '.agent-kit', 'releases', sha) : `releases/${sha}`)

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, '..', 'bin', 'agent-kit-install')
const KIT = process.env.AGENT_KIT_TEST_SOURCE || join(homedir(), 'agent-kit')
const lib = createRequire(import.meta.url)(INSTALLER)
// What both registrations must use on this machine (independent of the installer's own resolution).
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => existsSync(p)) ?? lib.resolveNode().path

let BASE
let TEMPLATE
let SOURCE // shared clean source repo

const GIT = IS_WINDOWS
  ? ['C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\bin\\git.exe'].find(existsSync)
  : ['/usr/bin/git', '/opt/homebrew/bin/git'].find(existsSync)
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
// Claude Code keeps one set of settings per config directory, and the installer
// now registers in each of them, so the fake keeps one state file per directory:
// the primary one stays where it was, the others get a suffixed name.
const configDir = process.env.CLAUDE_CONFIG_DIR || ''
if (process.env.FAKE_CLAUDE_FAIL_DIR && configDir === process.env.FAKE_CLAUDE_FAIL_DIR) {
  console.error('fake claude: Your organization has disabled Claude subscription access')
  process.exit(1)
}
const base = process.env.FAKE_CLAUDE_STATE
const file = !configDir || configDir === process.env.FAKE_CLAUDE_PRIMARY_DIR
  ? base
  : base.replace(/\\.json$/, '-' + require('path').basename(configDir) + '.json')
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
  // Refused once, so a best-effort restore afterwards can still succeed — that is
  // what the installer does after a failed replace.
  if (process.env.FAKE_CLAUDE_FAIL_ADD_DIR && configDir === process.env.FAKE_CLAUDE_FAIL_ADD_DIR) {
    const marker = file + '.add-refused'
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1')
      console.error('fake claude: add refused in this account')
      process.exit(1)
    }
  }
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
  // Windows cannot execute an extension-less shebang file at all — write the
  // fake's JS logic to its own file and front it with a .cmd shim, the same
  // shape a real npm-installed CLI takes there (see agent-kit-install's own
  // cmdShimContent). POSIX keeps the original single shebang-script shape.
  const claude = join(fakebin, IS_WINDOWS ? 'claude.cmd' : 'claude')
  const codexBin = join(fakebin, IS_WINDOWS ? 'codex.cmd' : 'codex')
  if (!IS_WINDOWS) {
    writeFileSync(claude, `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o755 })
    writeFileSync(codexBin, `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 })
  } else {
    writeFileSync(join(fakebin, 'claude-impl.js'), FAKE_CLAUDE)
    writeFileSync(claude, `@node "${join(fakebin, 'claude-impl.js')}" %*\r\n`)
    writeFileSync(join(fakebin, 'codex-impl.js'), FAKE_CODEX)
    writeFileSync(codexBin, `@node "${join(fakebin, 'codex-impl.js')}" %*\r\n`)
  }
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
  // And an unrelated user rule beside the one agent-kit installs.
  mkdirSync(join(home, '.claude', 'rules'), { recursive: true })
  writeFileSync(join(home, '.claude', 'rules', 'my-own-rule.md'), 'mine\n')

  const env = {
    ...cleanEnv(),
    PATH: `${fakebin}${delimiter}${process.env.PATH}`,
    FAKE_CLAUDE_LOG: claudeLog,
    FAKE_CLAUDE_STATE: claudeStateFile,
    FAKE_CLAUDE_PRIMARY_DIR: join(home, '.claude'),
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
    // Registration recorded for a non-primary config directory (see FAKE_CLAUDE).
    claudeStateIn: (dirName) => {
      const f = claudeStateFile.replace(/\.json$/, `-${dirName}.json`)
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
    },
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
  // 'projects': this machine's own registries (e.g. projects/tripix) are
  // exactly the kind of local, un-reproducible runtime state '.collab' is
  // excluded for — a real one leaking into TEMPLATE would ride along into
  // every built release once copyLiveProjectRegistries (agent-kit-install)
  // starts reading projects/ from disk, and its real policy config can trip
  // kit-test assertions that have nothing to do with the test being run
  // (found 2026-09-16 writing the project-registry copy test below).
  const skip = new Set(['.git', 'node_modules', '.collab', 'projects', '.DS_Store', '__pycache__'])
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
    const viaPath = lib.resolveNode({ candidates: [missing], pathEnv: `relative/dir${delimiter}${join(dir, 'empty')}${delimiter}${brewBin}` })
    assert.equal(viaPath.path, real)
    assert.match(viaPath.warning, /resolved from PATH.*may break when Node is upgraded/)
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

// The Windows link branch cannot be exercised end to end here, but its
// plan-time/apply-time split can be: planning runs BEFORE `current` is
// switched, so a file entry's source may not exist yet — on a first install
// (no `current`) or on an upgrade from a release older than the entry
// (rules/orchestration.md, 2026-09-17). It used to readFileSync at plan time
// and refuse the whole install with ENOENT.
test('Windows file links: a source missing at plan time defers to apply, and a release without it keeps the installed copy', () => {
  const home = join(BASE, 'winplan-home')
  const release = join(home, '.agent-kit', 'current')
  for (const rel of ['agents/implementer.md', 'agents/verifier.md', 'skills/codex-review/SKILL.md', 'skills/ui-review/SKILL.md', 'bin/collab']) {
    mkdirSync(join(release, dirname(rel)), { recursive: true })
    writeFileSync(join(release, rel), `${rel}\n`)
  }
  const ctx = {
    home,
    bindir: join(home, 'bin'),
    kitDir: join(home, '.agent-kit'),
    kitDirReal: join(home, '.agent-kit'),
    currentPath: release
  }
  mkdirSync(ctx.bindir, { recursive: true })

  // No rules/ in this release: planning must not throw, and must not guess.
  const plan = lib.planLinksWindows(ctx)
  const rule = plan.find((item) => item.rel === 'rules/orchestration.md')
  assert.equal(rule.action, 'create')
  assert.equal(rule.content, null, 'the content read is deferred, not performed at plan time')

  // Apply with the release still missing it: the installed copy (none here) is
  // left alone and the run survives.
  let changes = []
  lib.applyLinksWindows(ctx, plan, new lib.Journal(), changes)
  const dest = join(home, '.claude', 'rules', 'orchestration.md')
  assert.equal(existsSync(dest), false)
  assert.ok(changes.some((c) => /kept .*orchestration\.md as it is/.test(c)), changes.join('\n'))
  assert.equal(readFileSync(join(home, '.claude', 'agents', 'verifier.md'), 'utf8'), 'agents/verifier.md\n')

  // The same plan, once the switched-to release does carry the rule.
  mkdirSync(join(release, 'rules'), { recursive: true })
  writeFileSync(join(release, 'rules', 'orchestration.md'), 'rule v2\n')
  changes = []
  lib.applyLinksWindows(ctx, lib.planLinksWindows(ctx), new lib.Journal(), changes)
  assert.equal(readFileSync(dest, 'utf8'), 'rule v2\n')
  const manifest = JSON.parse(readFileSync(join(ctx.kitDir, 'windows-links.json'), 'utf8'))
  assert.ok(manifest[dest], 'ownership is recorded, so the next run does not call it foreign')

  // The ordinary upgrade, in the order the installer really runs it: the plan
  // is computed while `current` still points at the release being LEFT, the
  // switch happens, and only then is the copy applied. Reading the source at
  // plan time would copy the old release's bytes and leave the destination a
  // release behind.
  const planned = lib.planLinksWindows(ctx)
  writeFileSync(join(release, 'rules', 'orchestration.md'), 'rule v3\n')
  writeFileSync(join(release, 'agents', 'verifier.md'), 'verifier v3\n')
  changes = []
  lib.applyLinksWindows(ctx, planned, new lib.Journal(), changes)
  assert.equal(readFileSync(dest, 'utf8'), 'rule v3\n', 'the copy comes from the release being installed')
  assert.equal(readFileSync(join(home, '.claude', 'agents', 'verifier.md'), 'utf8'), 'verifier v3\n')
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
  // `current` on every install/rollback (posixCopy in agent-kit-install's
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

  const sha3 = commitChange(SOURCE, 'skills/codex-review/SKILL.md', `${original}\nrelease-three\n`)
  assert.equal(A.run(['--source', SOURCE, '--skip-kit-tests']).status, 0)
  const sha4 = commitChange(SOURCE, 'skills/codex-review/SKILL.md', `${original}\nrelease-four\n`)
  r = A.run(['--source', SOURCE, '--skip-kit-tests'])
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
  // The migration trap on a machine that kept the rule by hand before
  // agent-kit owned it: no manifest record, so it is refused, not overwritten.
  writeFileSync(join(W.home, '.claude', 'rules', 'orchestration.md'), 'my own rule\n')
  if (!IS_WINDOWS) {
    symlinkSync('/somewhere/else/collab', join(W.bindir, 'collab'))
  } else {
    // No symlink mechanism to abuse on Windows — a foreign file the manifest
    // has no record of is the equivalent conflict there.
    writeFileSync(join(W.bindir, 'collab.cmd'), '@echo off\r\necho someone else\'s shim\r\n')
  }
  const before = W.snapshot()
  const r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  if (!IS_WINDOWS) {
    // verifier.md is now a posixCopy entry (see linkSpecs): ownership is
    // tracked by content hash, same wording as the Windows branch below,
    // not "not an agent-kit symlink" — there is no link here to complain about.
    assert.match(r.stderr, /verifier\.md exists and was not created by this installer/)
    assert.match(r.stderr, /collab is a symlink to \/somewhere\/else\/collab/)
  } else {
    assert.match(r.stderr, /verifier\.md exists and was not created by this installer/)
    assert.match(r.stderr, /collab\.cmd exists and was not created by this installer/)
  }
  assert.match(r.stderr, /orchestration\.md exists and was not created by this installer/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])
})

test('posixCopy: a foreign directory is refused; a legitimate copy is a real dir/file (not a symlink), refreshes on content change, and reinstalling the same commit leaves it and its manifest untouched', () => {
  if (IS_WINDOWS) return // posixCopy only changes behaviour off Windows; Windows already copied these

  const W = makeWorld('posix-copy')
  mkdirSync(join(W.home, '.claude', 'skills', 'codex-review'), { recursive: true })
  writeFileSync(join(W.home, '.claude', 'skills', 'codex-review', 'SKILL.md'), "not agent-kit's\n")
  const beforeForeign = W.snapshot()
  let r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /codex-review exists and was not created by this installer/)
  assert.deepEqual(W.snapshot(), beforeForeign, 'refused before anything else ran')

  rmSync(join(W.home, '.claude', 'skills', 'codex-review'), { recursive: true, force: true })
  r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  const cur = W.kit('current')
  const skillDest = join(W.home, '.claude', 'skills', 'codex-review')
  const agentDest = join(W.home, '.claude', 'agents', 'verifier.md')
  assert.equal(lstatSync(skillDest).isSymbolicLink(), false)
  assert.equal(lstatSync(agentDest).isSymbolicLink(), false)
  assert.ok(readFileSync(join(skillDest, 'SKILL.md')).equals(readFileSync(join(cur, 'skills', 'codex-review', 'SKILL.md'))))

  // Content propagates on a normal reinstall of a changed commit — proven
  // for the directory kind by the rollback test below; proven here for the
  // file kind (agents/*.md), which shares the same apply-time-fresh-read
  // path but is a different branch in applyLinksPosix.
  const originalAgent = readFileSync(join(SOURCE, 'agents', 'verifier.md'), 'utf8')
  const sha2 = commitChange(SOURCE, 'agents/verifier.md', `${originalAgent}\nposix-copy marker\n`)
  r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`installed: ${sha2}`))
  assert.match(readFileSync(agentDest, 'utf8'), /posix-copy marker/)

  // Reinstalling the identical commit is a true no-op: neither the copies
  // nor posix-copies.json (the ownership manifest) are rewritten.
  const manifestPath = join(W.home, '.agent-kit', 'posix-copies.json')
  const manifestBefore = readFileSync(manifestPath, 'utf8')
  const snapshotBefore = W.snapshot()
  r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore)
  assert.deepEqual(W.snapshot(), snapshotBefore)
})

test('posixCopy: migrating from an older install that left plain symlinks-through-current replaces them with real copies, not a refusal', () => {
  if (IS_WINDOWS) return // the symlink layout this migrates away from never existed on Windows

  const W = makeWorld('posix-migrate')
  let r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  const cur = W.kit('current')
  const skillDest = join(W.home, '.claude', 'skills', 'codex-review')
  const agentDest = join(W.home, '.claude', 'agents', 'verifier.md')

  // Simulate the layout this exact fix replaces: a plain symlink through
  // `current`, the same shape every OTHER user-level entry still uses.
  rmSync(skillDest, { recursive: true, force: true })
  symlinkSync(join(cur, 'skills', 'codex-review'), skillDest)
  rmSync(agentDest, { force: true })
  symlinkSync(join(cur, 'agents', 'verifier.md'), agentDest)

  r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /migrated from a symlink/)
  assert.equal(lstatSync(skillDest).isSymbolicLink(), false, 'no longer a symlink')
  assert.equal(lstatSync(agentDest).isSymbolicLink(), false, 'no longer a symlink')
  assert.ok(readFileSync(join(skillDest, 'SKILL.md')).equals(readFileSync(join(cur, 'skills', 'codex-review', 'SKILL.md'))))
  assert.ok(readFileSync(agentDest).equals(readFileSync(join(cur, 'agents', 'verifier.md'))))

  // Already migrated — running again is a true no-op.
  r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
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
  // NTFS has no POSIX permission bits to preserve.
  if (!IS_WINDOWS) assert.equal((lstatSync(configPath).mode & 0o777).toString(8), '644', 'mode kept')

  const again = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(again.status, 0, again.all)
  assert.equal(readdirSync(join(W.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-')).length, 1, 'already correct: no write, no backup')
})

// The npm package `@google/gemini-cli` this targeted no longer exists for an
// individual account (Google cut it off 2026-06-18); the working, already
// authenticated client is Antigravity CLI (`agy`), confirmed live on
// 2026-09-15 to read exactly this file in exactly this shape.
const geminiEntry = (home) => ({
  command: NODE,
  args: [join(home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')],
  env: { COLLAB_AGENT_ID: 'gemini' }
})

test('Gemini config: created fresh with disabled:false, an existing unrelated server and disabled:true are kept', () => {
  const W = makeWorld('gemini-fresh')
  let r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /gemini: created .*mcp_config\.json with mcpServers\.collab/)
  const configPath = join(W.home, '.gemini', 'config', 'mcp_config.json')
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    mcpServers: { collab: { ...geminiEntry(W.home), disabled: false } }
  })

  const again = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(again.status, 0, again.all)
  assert.match(again.stdout, /changed: nothing/)
  assert.equal(readFileSync(configPath, 'utf8').includes('gemini: created'), false)
})

test('Gemini config: an existing collab entry is updated, disabled:true and an unrelated server survive, backup written', () => {
  const configDir = join('.gemini', 'config')
  const original = JSON.stringify(
    {
      mcpServers: {
        // Not ours: must survive byte-for-byte.
        other: { command: 'other-server', args: [], env: {} },
        // Stale command (an older release path) AND explicitly disabled by
        // the owner via `agy mcp disable collab` — the install must fix the
        // command without silently re-enabling what was turned off.
        collab: { command: 'node', args: ['/old/path/server.mjs'], env: { COLLAB_AGENT_ID: 'gemini' }, disabled: true }
      }
    },
    null,
    2
  ) + '\n'
  const W = makeWorld('gemini-update')
  mkdirSync(join(W.home, configDir), { recursive: true })
  writeFileSync(join(W.home, configDir, 'mcp_config.json'), original)

  const r = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /gemini: updated mcpServers\.collab/)
  const configPath = join(W.home, configDir, 'mcp_config.json')
  const written = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(written.mcpServers.other, { command: 'other-server', args: [], env: {} }, 'unrelated server untouched')
  assert.deepEqual(written.mcpServers.collab, { ...geminiEntry(W.home), disabled: true }, 'command fixed, disabled:true preserved')

  const backups = readdirSync(join(W.home, configDir)).filter((f) => f.startsWith('mcp_config.json.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(W.home, configDir, backups[0]), 'utf8'), original)

  const again = W.run(['--source', SOURCE, '--skip-kit-tests'])
  assert.equal(again.status, 0, again.all)
  assert.equal(
    readdirSync(join(W.home, configDir)).filter((f) => f.startsWith('mcp_config.json.backup-')).length,
    1,
    'already correct (disabled:true and all): no write, no backup'
  )
})

const NO_VENDOR_PATH = '/no-vendor-cli-on-this-path'

test('--skip-codex and --skip-gemini leave both untouched and say why, without touching Claude', () => {
  const W = makeWorld('explicit-skip', { codex: null })
  const r = W.run(['--source', SOURCE, '--skip-kit-tests', '--skip-codex', '--skip-gemini'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /codex: skipped — requested with --skip-codex/)
  assert.match(r.stdout, /gemini: skipped — requested with --skip-gemini/)
  assert.equal(existsSync(join(W.home, '.codex')), false, 'no ~/.codex for a flag nobody asked to skip past')
  assert.equal(existsSync(join(W.home, '.gemini')), false)
  // Claude, not skipped, still registered normally.
  assert.deepEqual(mutating(W.claudeCalls()).length > 0, true)
})

test('a vendor with no CLI and no prior state is skipped automatically, creating nothing', () => {
  const W = makeWorld('no-vendor', { codex: null })
  // run() always appends its own --claude-bin pointing at the fake binary
  // makeWorld created; parseArgs keeps the LAST occurrence of a flag, so a
  // second --claude-bin here is what actually simulates Claude being absent —
  // overriding PATH alone cannot, since claudeBin is an absolute path, not a
  // bare command looked up on it.
  const r = W.run(['--source', SOURCE, '--skip-kit-tests', '--claude-bin', join(W.root, 'no-such-claude')], { PATH: NO_VENDOR_PATH })
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /claude: skipped — .* not found on PATH/)
  assert.match(r.stdout, /codex: skipped — codex is not installed and ~\/\.codex does not exist yet/)
  assert.match(r.stdout, /gemini: skipped — agy \(Antigravity CLI\) is not installed and ~\/\.gemini does not exist yet/)
  assert.equal(existsSync(join(W.home, '.codex')), false)
  assert.equal(existsSync(join(W.home, '.gemini')), false)
  assert.deepEqual(W.claudeCalls(), [], 'claude was never even invoked — its binary is not on this PATH')

  // The rest of the install still succeeds: an absent vendor is not fatal.
  assert.equal(existsSync(join(W.home, '.agent-kit', 'current')), true)
})

test('a vendor with no CLI but a pre-existing config is still kept in sync, not skipped', () => {
  const original = `# Codex settings\nmodel = "gpt-5"\n`
  const W = makeWorld('stale-vendor', { codex: original })
  mkdirSync(join(W.home, '.gemini', 'config'), { recursive: true })
  const geminiOriginal = JSON.stringify({ mcpServers: { collab: { command: 'node', args: ['/old/server.mjs'], env: { COLLAB_AGENT_ID: 'gemini' } } } }, null, 2) + '\n'
  writeFileSync(join(W.home, '.gemini', 'config', 'mcp_config.json'), geminiOriginal)

  const r = W.run(['--source', SOURCE, '--skip-kit-tests'], { PATH: NO_VENDOR_PATH })
  assert.equal(r.status, 0, r.all)
  assert.doesNotMatch(r.stdout, /codex: skipped/)
  assert.doesNotMatch(r.stdout, /gemini: skipped/)
  assert.match(r.stdout, /codex: appended \[mcp_servers\.collab\]/)
  assert.match(r.stdout, /gemini: updated mcpServers\.collab/)
  assert.equal(readFileSync(join(W.home, '.codex', 'config.toml'), 'utf8'), `${original}\n${expectedBlock(W.home)}\n`)
  assert.equal(JSON.parse(readFileSync(join(W.home, '.gemini', 'config', 'mcp_config.json'), 'utf8')).mcpServers.collab.args[0], join(W.home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs'))
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
  // verifier.md is a posixCopy entry (see linkSpecs): "copy ... <- ..."
  // wording, not "link ... ->" — there is no symlink to point at.
  assert.match(r.stdout, /copy .*verifier\.md <- .*current[\\/]agents[\\/]verifier\.md \(create\)/)
  assert.match(r.stdout, /copy .*rules[\\/]orchestration\.md <- .*current[\\/]rules[\\/]orchestration\.md \(create\)/)
  // bin/collab is unaffected: still a plain symlink, still "link ... ->".
  assert.match(r.stdout, /link .*collab -> .*current[\\/]bin[\\/]collab \(create\)/)
  assert.match(r.stdout, /codex: append \[mcp_servers\.collab\]/)
  assert.match(r.stdout, /claude: add user-scope collab/)
  assert.match(r.stdout, /gemini: create mcpServers\.collab/)
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

  // Running again changes nothing: both directories are already in step.
  const again = W.run(['--source', source, '--skip-kit-tests', '--claude-config-dir', second])
  assert.equal(again.status, 0, again.all)
  assert.doesNotMatch(again.stdout, /registered user-scope collab/)
})

test('CLAUDE_CONFIG_DIR inside the home is picked up; outside it is ignored', () => {
  const W = makeWorld('env-dir')
  const source = makeSource('env-dir')
  const inside = accountDir(W, '.claude-work')
  const r = W.run(['--source', source, '--skip-kit-tests'], { CLAUDE_CONFIG_DIR: inside })
  assert.equal(r.status, 0, r.all)
  assert.ok(existsSync(join(inside, 'rules', 'orchestration.md')), 'directory from the environment is installed into')

  const outside = join(BASE, 'somebody-elses-home', '.claude')
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
  const outside = join(BASE, 'outside-home-claude')
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
  const outside = join(BASE, 'outside-default-claude')
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
  const root = join(BASE, 'toctou')
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
