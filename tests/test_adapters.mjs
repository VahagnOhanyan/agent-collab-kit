// Stage 2 of vendor-probe: a checked profile becomes a machine adapter (agent-kit-install --adopt-profile). What must
// hold: nothing is written without the owner's "да"; only a registration the probe proved is used; the vendor's other
// settings survive byte for byte where they are not ours; the vendor's own check runs after the write, and a failed
// check puts everything back. A fake `grok` on PATH prints the settings file, so the check sees what was really written.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = createRequire(import.meta.url)(join(ROOT, 'bin', 'agent-kit-install'))
const skipWindows = process.platform === 'win32'

function world({ checkPrints = 'settings' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'kit-adapters-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  mkdirSync(join(home, '.grok'), { recursive: true })
  mkdirSync(bin)
  // `grok mcp list`: the settings under $HOME as they are on disk — so the check proves it ran against THIS home —
  // or nothing, or the right words with a failing exit code.
  const printed = {
    settings: 'cat "$HOME/.grok"/* 2>/dev/null',
    nothing: 'true',
    'settings-then-fail': 'cat "$HOME/.grok"/* 2>/dev/null; exit 1'
  }[checkPrints]
  writeFileSync(join(bin, 'grok'), `#!/bin/sh\n${printed}\n`)
  chmodSync(join(bin, 'grok'), 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${savedPath}`
  const ctx = (profileFile, answer) => ({
    opts: { adoptProfile: profileFile },
    home,
    kitDir: join(home, '.agent-kit'),
    currentPath: ROOT, // the skill's checker and the built-in catalog, read from this source tree
    node: { path: '/usr/bin/node' },
    serverPath: join(home, '.agent-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs'),
    ...(answer === undefined ? {} : { confirm: async () => answer })
  })
  return {
    base,
    home,
    ctx,
    adapter: join(home, '.agent-kit', 'collab', 'adapters', 'grok.json'),
    cleanup: () => { process.env.PATH = savedPath; rmSync(base, { recursive: true, force: true }) }
  }
}

function profile(registration, { mcpStatus = 'verified', id = 'grok', binary = 'grok' } = {}) {
  const none = { status: 'not_found', evidence: '' }
  return {
    id, vendor: 'xai', binary, version: '1.0',
    headless: { ...none }, readonly: { ...none }, config: { ...none }, hooks: { ...none }, auth: { ...none }, limits: { ...none },
    mcp: { status: mcpStatus, evidence: 'grok mcp add wrote the entry in a temporary HOME; grok mcp list showed it', ...(registration ? { registration } : {}) },
    models: [{ id: 'grok-small', tier_guess: 'cheap', source: 'grok --help' }]
  }
}

const JSON_REG = { kind: 'json-file', config_path: '~/.grok/settings.json', servers_key: 'mcpServers', entry_extra: { timeout: 20 }, verify: { argv: ['grok', 'mcp', 'list'], expect: 'COLLAB_AGENT_ID' } }
const writeProfile = (w, value) => {
  const file = join(w.base, 'profile.json')
  writeFileSync(file, JSON.stringify(value))
  return file
}
const backups = (w) => readdirSync(join(w.home, '.grok')).filter((name) => name.includes('.backup-'))

test('json: after "да" the adapter is written, collab is merged in, the vendor\'s other settings stay, a backup is kept', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const settings = join(w.home, '.grok', 'settings.json')
    writeFileSync(settings, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2))
    const code = await lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true))
    assert.equal(code, 0)
    const written = JSON.parse(readFileSync(settings, 'utf8'))
    assert.equal(written.theme, 'dark')
    assert.deepEqual(written.mcpServers.other, { command: 'x' })
    assert.deepEqual(written.mcpServers.collab, { command: '/usr/bin/node', args: [w.ctx().serverPath], env: { COLLAB_AGENT_ID: 'grok' }, timeout: 20 })
    const adapter = JSON.parse(readFileSync(w.adapter, 'utf8'))
    assert.deepEqual([adapter.id, adapter.provider, adapter.binary, adapter.registration.kind], ['grok', 'xai', 'grok', 'json-file'])
    assert.equal(backups(w).length, 1)
  } finally {
    w.cleanup()
  }
})

test('without "да", or without a terminal, nothing is written', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const settings = join(w.home, '.grok', 'settings.json')
    writeFileSync(settings, '{"theme":"dark"}\n')
    assert.equal(await lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), false)), 1)
    // No ctx.confirm and a test process has no terminal: the question cannot be asked, so nothing happens.
    assert.equal(await lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)))), 1)
    assert.equal(readFileSync(settings, 'utf8'), '{"theme":"dark"}\n')
    assert.equal(existsSync(w.adapter), false)
    assert.equal(backups(w).length, 0)
  } finally {
    w.cleanup()
  }
})

test('a check that does not confirm collab puts the settings file back and writes no adapter', { skip: skipWindows }, async () => {
  const w = world({ checkPrints: 'nothing' })
  try {
    const settings = join(w.home, '.grok', 'settings.json')
    const before = '{\n  "theme": "dark"\n}\n'
    writeFileSync(settings, before)
    await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true)), /did not confirm collab/)
    assert.equal(readFileSync(settings, 'utf8'), before)
    assert.equal(existsSync(w.adapter), false)
    assert.equal(backups(w).length, 0, 'the backup of an undone write goes too')
  } finally {
    w.cleanup()
  }
})

test('toml: collab gets its own table; the tables around it stay byte for byte', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const settings = join(w.home, '.grok', 'config.toml')
    const before = '# mine\n[other]\na = 1\n'
    writeFileSync(settings, before)
    const reg = { ...JSON_REG, kind: 'toml-file', config_path: '~/.grok/config.toml', servers_key: 'mcp_servers' }
    assert.equal(await lib.adoptProfile(w.ctx(writeProfile(w, profile(reg)), true)), 0)
    const text = readFileSync(settings, 'utf8')
    assert.ok(text.startsWith(before), 'what was there is kept as it was')
    assert.match(text, /\[mcp_servers\.collab\]\n# Managed by agent-kit-install: machine adapter grok/)
    assert.match(text, /env = \{ COLLAB_AGENT_ID = "grok" \}\ntimeout = 20\n$/)
  } finally {
    w.cleanup()
  }
})

test('refused: an unproven registration, a check that runs another program, no registration, a cli registration, a built-in vendor, a path out of the home', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const cases = [
      ['documented only', profile(JSON_REG, { mcpStatus: 'documented' }), /verified/],
      ['check runs another program', profile({ ...JSON_REG, verify: { argv: ['sh', '-c', 'echo COLLAB_AGENT_ID'], expect: 'COLLAB_AGENT_ID' } }), /argv\[0\]/],
      ['no registration', profile(null), /mcp\.registration/],
      ['cli', profile({ kind: 'cli', verify: JSON_REG.verify }), /cli/],
      ['built-in vendor', profile({ ...JSON_REG, verify: { argv: ['codex', 'mcp', 'list'], expect: 'collab' } }, { id: 'codex', binary: 'codex' }), /встроенный вендор/],
      ['out of the home', profile({ ...JSON_REG, config_path: '~/../etc/grok.json' }), /config_path/],
      ['a reserved field', profile({ ...JSON_REG, entry_extra: { command: 'evil' } }), /command/]
    ]
    for (const [name, value, why] of cases) {
      await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, value), true)), why, name)
    }
    assert.equal(existsSync(w.adapter), false)
  } finally {
    w.cleanup()
  }
})

test('a later install keeps an adopted vendor in sync, and refuses a hand-broken adapter by name', { skip: skipWindows }, async () => {
  const w = world()
  try {
    assert.equal(await lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true)), 0)
    const same = lib.planAdapters(w.ctx())
    assert.equal(same.items[0].changed, false, 'nothing to do when the registration is as adopted')
    const adapter = JSON.parse(readFileSync(w.adapter, 'utf8'))
    writeFileSync(w.adapter, JSON.stringify({ ...adapter, registration: { ...adapter.registration, verify: { argv: ['rm', '-rf', '/'], expect: 'xyz' } } }))
    assert.throws(() => lib.planAdapters(w.ctx()), /not the one the owner approved/)
  } finally {
    w.cleanup()
  }
})

// Review finding 1 (blocker): an adapter written by hand must never get a program run at a normal install — not
// without the approval mark, and not with a mark either when its "vendor" is a shell.
test('a hand-made adapter runs nothing: without the approval mark it is refused, and a shell is never a vendor', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const pwned = join(w.base, 'pwned')
    const evil = { id: 'evil', binary: 'sh', registration: { kind: 'json-file', config_path: '~/.grok/evil.json', servers_key: 'mcpServers', verify: { argv: ['sh', '-c', `touch ${pwned}; echo collab`], expect: 'collab' } } }
    mkdirSync(dirname(w.adapter), { recursive: true })
    const file = join(dirname(w.adapter), 'evil.json')
    writeFileSync(file, JSON.stringify(evil))
    assert.throws(() => lib.planAdapters(w.ctx()), /not the one the owner approved/)
    writeFileSync(`${file}.approved`, `${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`)
    assert.throws(() => lib.planAdapters(w.ctx()), /shell or an interpreter/)
    assert.equal(existsSync(pwned), false, 'nothing was run')
  } finally {
    w.cleanup()
  }
})

test('the check must exit 0 with the words on stdout; an error that names collab does not confirm it', { skip: skipWindows }, async () => {
  const w = world({ checkPrints: 'settings-then-fail' })
  try {
    const settings = join(w.home, '.grok', 'settings.json')
    writeFileSync(settings, '{}\n')
    await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true)), /exited with 1/)
    assert.equal(readFileSync(settings, 'utf8'), '{}\n')
    assert.equal(existsSync(w.adapter), false)
  } finally {
    w.cleanup()
  }
})

test('refused before anything is written: a link out of the home, a built-in vendor\'s program, an id collab would not read, a check that says nothing', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const outside = join(w.base, 'outside')
    mkdirSync(outside)
    rmSync(join(w.home, '.grok'), { recursive: true })
    symlinkSync(outside, join(w.home, '.grok'))
    await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true)), /resolves outside the home/)
    assert.deepEqual(readdirSync(outside), [], 'nothing written through the link')
    const cases = [
      ['built-in program', profile({ ...JSON_REG, verify: { argv: ['codex', 'mcp', 'list'], expect: 'collab' } }, { id: 'mycodex', binary: 'codex' }), /встроенный вендор/],
      ['id collab would not read', profile(JSON_REG, { id: '1' }), /\$\.id/],
      ['empty check', profile({ ...JSON_REG, verify: { argv: ['grok', 'mcp', 'list'], expect: '\n' } }), /verify\.expect/]
    ]
    for (const [name, value, why] of cases) await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, value), true)), why, name)
    assert.equal(existsSync(w.adapter), false)
  } finally {
    w.cleanup()
  }
})
