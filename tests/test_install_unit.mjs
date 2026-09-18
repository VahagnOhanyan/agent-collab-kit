// Pure functions of bin/agent-kit-install: no install runs here.
//
// Shared world and fakes: tests/helpers/install-world.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setup, lib } from './helpers/install-world.mjs'

const world = setup()

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
  const home = join(world.base, 'winplan-home')
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
