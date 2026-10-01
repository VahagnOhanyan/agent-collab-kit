// Shared world for the bin/agent-collab-kit-install tests. The suite is split into
// several files (tests/test_install_*.mjs) so `node --test` runs them in
// parallel processes: each file builds its own temp HOME, fake CLIs and source
// repository through setup() below.
//
// Every test builds its own world in a temp directory: a temp HOME, a temp
// bindir, a fake `claude` and a fake `codex` that record their argv, and a temp
// source git repository made from a file copy of ~/agent-collab-kit (never modified).
// Nothing here touches the real ~/.agent-collab-kit, ~/.claude, ~/.codex or bindir.
//
// Only two installs run the kit's own test suite (about a minute each): the
// clean install, and the one proving a failing kit test refuses the install.
// Every other install passes the hidden --skip-kit-tests; the smoke test
// (check-config + MCP handshake) still runs in all of them.

import { before, after } from 'node:test'
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
// agent-collab-kit-install's own normaliseLinkTarget, so these tests compare
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
// switchCurrent's comment in agent-collab-kit-install.
const currentTarget = (home, sha) => (IS_WINDOWS ? join(home, '.agent-collab-kit', 'releases', sha) : `releases/${sha}`)

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLER = join(HERE, '..', '..', 'bin', 'agent-collab-kit-install')
const KIT = process.env.AGENT_COLLAB_KIT_TEST_SOURCE || join(homedir(), 'agent-collab-kit')
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
  // shape a real npm-installed CLI takes there (see agent-collab-kit-install's own
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
  // And an unrelated user rule beside the one agent-collab-kit installs.
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
    kit: (...p) => join(home, '.agent-collab-kit', ...p),
    history: () => readFileSync(join(home, '.agent-collab-kit', 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
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
    '# Managed by agent-collab-kit-install: the active agent-collab-kit release, through ~/.agent-collab-kit/current.',
    `command = "${NODE}"`,
    `args = ["${home}/.agent-collab-kit/current/collab/src/mcp/server.mjs"]`,
    'env = { COLLAB_AGENT_ID = "codex" }',
    'startup_timeout_sec = 20'
  ].join('\n')

export function setup() {
  before(() => {
    BASE = realpathSync(mkdtempSync(join(tmpdir(), 'agent-collab-kit-install-test-')))
    TEMPLATE = join(BASE, 'template')
    // 'projects': this machine's own registries (e.g. projects/<id>) are
    // exactly the kind of local, un-reproducible runtime state '.collab' is
    // excluded for — a real one leaking into TEMPLATE would ride along into
    // every built release once copyLiveProjectRegistries (agent-collab-kit-install)
    // starts reading projects/ from disk, and its real policy config can trip
    // kit-test assertions that have nothing to do with the test being run
    // (found 2026-09-16 writing the project-registry copy test below).
    const skip = new Set(['.git', 'node_modules', '.collab', 'projects', '.DS_Store', '__pycache__'])
    cpSync(KIT, TEMPLATE, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.has(src.split('/').pop()) })
    // ~/agent-collab-kit/agents may still be empty while Ф4 is in progress.
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

  // BASE, TEMPLATE and SOURCE only exist once before() has run, so they are
  // reached through getters rather than handed out at import time.
  return {
    get base() { return BASE },
    get source() { return SOURCE }
  }
}

export {
  IS_WINDOWS,
  LAUNCHER_NAME,
  normaliseTarget,
  readLink,
  currentTarget,
  INSTALLER,
  KIT,
  lib,
  NODE,
  git,
  cleanEnv,
  makeSource,
  commitChange,
  shaOf,
  makeWorld,
  snapshot,
  mutating,
  expectedBlock,
  FAKE_CLAUDE,
  CODEX_FIXTURE
}
