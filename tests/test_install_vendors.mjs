// Refusals, foreign files, copy ownership and the vendor configs (Codex,
// Gemini). Runs the kit's own test suite once (the failing-kit-test refusal).
//
// Shared world and fakes: tests/helpers/install-world.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setup, IS_WINDOWS, NODE, git, makeSource, commitChange, makeWorld, snapshot, mutating, expectedBlock } from './helpers/install-world.mjs'

const world = setup()

// Codex as the lead reads ~/.codex/AGENTS.md, not Claude Code's rules/.
test('Codex gets the rules in a managed block of ~/.codex/AGENTS.md; the text around it is the person\'s and stays', () => {
  const W = makeWorld('codex-rules')
  const file = join(W.home, '.codex', 'AGENTS.md')
  writeFileSync(file, '# mine\n\nkeep this line\n')
  const r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# mine\n\nkeep this line\n'), 'the person\'s text is untouched')
  assert.match(text, /<!-- agent-kit: begin[\s\S]*<!-- agent-kit: end -->/)
  assert.equal(text.split('agent-kit: begin').length, 2, 'one block')
  // An index, not a copy: Codex reads at most 32 KiB of all AGENTS.md combined.
  const current = join(W.home, '.agent-kit', 'current')
  for (const rel of ['rules/orchestration.md', 'rules/vendor-claude.md', 'skills/ux-critic-review/SKILL.md', 'skills/ux-guidance/SKILL.md']) {
    assert.ok(text.includes(join(current, rel)), `points at ${rel}`)
  }
  assert.doesNotMatch(text, /# Оркестрация агентов/, 'the rules themselves are not inlined')
  assert.ok(Buffer.byteLength(text) < 8 * 1024, `the block stays small (${Buffer.byteLength(text)} bytes)`)

  const hooksFile = join(W.home, '.codex', 'hooks.json')
  const hooks = JSON.parse(readFileSync(hooksFile, 'utf8'))
  assert.ok(hooks.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.endsWith(`${join('.agent-kit', 'current', 'bin', 'agent-kit-hook')}" codex-guard`))))
  assert.match(r.stdout, /trust it once in Codex with \/hooks/)

  const again = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(again.status, 0, again.all)
  assert.equal(readFileSync(file, 'utf8'), text, 'a second install changes nothing')
  assert.deepEqual(JSON.parse(readFileSync(hooksFile, 'utf8')), hooks, 'nor the hooks')
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

  const empty = join(world.base, 'src-empty')
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
  const r = W.run(['--source', world.source, '--skip-kit-tests'])
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
  let r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /codex-review exists and was not created by this installer/)
  assert.deepEqual(W.snapshot(), beforeForeign, 'refused before anything else ran')

  rmSync(join(W.home, '.claude', 'skills', 'codex-review'), { recursive: true, force: true })
  r = W.run(['--source', world.source, '--skip-kit-tests'])
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
  const originalAgent = readFileSync(join(world.source, 'agents', 'verifier.md'), 'utf8')
  const sha2 = commitChange(world.source, 'agents/verifier.md', `${originalAgent}\nposix-copy marker\n`)
  r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, new RegExp(`installed: ${sha2}`))
  assert.match(readFileSync(agentDest, 'utf8'), /posix-copy marker/)

  // Reinstalling the identical commit is a true no-op: neither the copies
  // nor posix-copies.json (the ownership manifest) are rewritten.
  const manifestPath = join(W.home, '.agent-kit', 'posix-copies.json')
  const manifestBefore = readFileSync(manifestPath, 'utf8')
  const snapshotBefore = W.snapshot()
  r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestBefore)
  assert.deepEqual(W.snapshot(), snapshotBefore)
})

test('posixCopy: migrating from an older install that left plain symlinks-through-current replaces them with real copies, not a refusal', () => {
  if (IS_WINDOWS) return // the symlink layout this migrates away from never existed on Windows

  const W = makeWorld('posix-migrate')
  let r = W.run(['--source', world.source, '--skip-kit-tests'])
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

  r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /migrated from a symlink/)
  assert.equal(lstatSync(skillDest).isSymbolicLink(), false, 'no longer a symlink')
  assert.equal(lstatSync(agentDest).isSymbolicLink(), false, 'no longer a symlink')
  assert.ok(readFileSync(join(skillDest, 'SKILL.md')).equals(readFileSync(join(cur, 'skills', 'codex-review', 'SKILL.md'))))
  assert.ok(readFileSync(agentDest).equals(readFileSync(join(cur, 'agents', 'verifier.md'))))

  // Already migrated — running again is a true no-op.
  r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /changed: nothing \(already installed and registered\)/)
})

test('a failure after changes began rolls back everything this run changed', () => {
  const W = makeWorld('mid-failure')
  const before = W.snapshot()
  const r = W.run(['--source', world.source, '--skip-kit-tests'], { FAKE_CLAUDE_FAIL_ADD: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /claude mcp add .* failed/)
  assert.match(r.stderr, /this run was rolled back/)
  assert.match(r.stderr, /undone: rewrote .*config\.toml/)
  assert.match(r.stderr, /undone: switched .*current/)
  assert.deepEqual(W.snapshot(), before, 'home, bindir and Claude state exactly as before')
})

test('a different user-scope collab registration is refused without --replace-claude', () => {
  const old = { scope: 'user', command: 'node', args: ['/Users/x/App/tools/collab/src/mcp/server.mjs'], env: { COLLAB_AGENT_ID: 'claude' } }
  const W = makeWorld('foreign-claude', { claudeState: { collab: old } })
  const before = W.snapshot()
  let r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /different user-scope "collab"/)
  assert.match(r.stderr, /App\/tools\/collab/)
  assert.match(r.stderr, /--replace-claude/)
  assert.deepEqual(W.snapshot(), before)
  assert.deepEqual(mutating(W.claudeCalls()), [])

  r = W.run(['--source', world.source, '--skip-kit-tests', '--replace-claude'])
  assert.equal(r.status, 0, r.all)
  const server = join(W.home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs')
  assert.deepEqual(mutating(W.claudeCalls()), [
    ['mcp', 'remove', '-s', 'user', 'collab'],
    ['mcp', 'add', '-s', 'user', 'collab', '-e', 'COLLAB_AGENT_ID=claude', '--', NODE, server]
  ])
  assert.deepEqual(W.claudeState().collab, { scope: 'user', command: NODE, args: [server], env: { COLLAB_AGENT_ID: 'claude' } })
})

test('Codex config: the existing collab block is replaced, everything else byte-identical, backup written', () => {
  const head = '# Codex — personal config\nmodel = "gpt-5"\n\n[projects."/Users/x/App"]\ntrust_level = "trusted"\n\n'
  const oldBlock =
    '[mcp_servers.collab]\n# Collaboration layer — shared tasks, messages, reviews, decisions and\n# approvals. Managed by tools/collab/codex/install.mjs; see docs/tooling/collab.md.\ncommand = "node"\nargs = ["/Users/x/App/tools/collab/src/mcp/server.mjs"]\nenv = { COLLAB_AGENT_ID = "codex" }\nstartup_timeout_sec = 20\n'
  const rest = '\n# the next table\n[mcp_servers.other]\ncommand = "other"\nnotes = """\n[mcp_servers.collab]\n"""\n'
  const original = head + oldBlock + rest
  const W = makeWorld('codex', { codex: original })
  const r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /codex: replaced \[mcp_servers\.collab\]/)
  assert.match(r.stdout, /replaced codex block was:\n\[mcp_servers\.collab\]\n# Collaboration layer/)
  const configPath = join(W.home, '.codex', 'config.toml')
  assert.equal(readFileSync(configPath, 'utf8'), `${head}${expectedBlock(W.home)}\n${rest}`)
  const backups = readdirSync(join(W.home, '.codex')).filter((f) => f.startsWith('config.toml.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(W.home, '.codex', backups[0]), 'utf8'), original)
  // NTFS has no POSIX permission bits to preserve.
  if (!IS_WINDOWS) assert.equal((lstatSync(configPath).mode & 0o777).toString(8), '644', 'mode kept')

  const again = W.run(['--source', world.source, '--skip-kit-tests'])
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
  let r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /gemini: created .*mcp_config\.json with mcpServers\.collab/)
  const configPath = join(W.home, '.gemini', 'config', 'mcp_config.json')
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), {
    mcpServers: { collab: { ...geminiEntry(W.home), disabled: false } }
  })

  const again = W.run(['--source', world.source, '--skip-kit-tests'])
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

  const r = W.run(['--source', world.source, '--skip-kit-tests'])
  assert.equal(r.status, 0, r.all)
  assert.match(r.stdout, /gemini: updated mcpServers\.collab/)
  const configPath = join(W.home, configDir, 'mcp_config.json')
  const written = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.deepEqual(written.mcpServers.other, { command: 'other-server', args: [], env: {} }, 'unrelated server untouched')
  assert.deepEqual(written.mcpServers.collab, { ...geminiEntry(W.home), disabled: true }, 'command fixed, disabled:true preserved')

  const backups = readdirSync(join(W.home, configDir)).filter((f) => f.startsWith('mcp_config.json.backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(W.home, configDir, backups[0]), 'utf8'), original)

  const again = W.run(['--source', world.source, '--skip-kit-tests'])
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
  const r = W.run(['--source', world.source, '--skip-kit-tests', '--skip-codex', '--skip-gemini'])
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
  const r = W.run(['--source', world.source, '--skip-kit-tests', '--claude-bin', join(W.root, 'no-such-claude')], { PATH: NO_VENDOR_PATH })
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

  const r = W.run(['--source', world.source, '--skip-kit-tests'], { PATH: NO_VENDOR_PATH })
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
  const r = W.run(['--source', world.source, '--skip-kit-tests', '--dry-run'])
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
