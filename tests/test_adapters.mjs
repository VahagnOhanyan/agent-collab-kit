// Stage 2 of vendor-probe: a checked profile becomes a machine adapter (agent-collab-kit-install --adopt-profile). What must
// hold: nothing is written without the owner's "да"; only a registration the probe proved is used; the vendor's other
// settings survive byte for byte where they are not ours; the vendor's own check runs after the write, and a failed
// check puts everything back. A fake `fixture-vendor` on PATH prints the settings file, so the check sees what was really written.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = createRequire(import.meta.url)(join(ROOT, 'bin', 'agent-collab-kit-install'))
const skipWindows = process.platform === 'win32'

function world({ checkPrints = 'settings' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'kit-adapters-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  mkdirSync(join(home, '.fixture-vendor'), { recursive: true })
  mkdirSync(bin)
  // `fixture-vendor mcp list`: the settings under $HOME as they are on disk — so the check proves it ran against THIS home —
  // or nothing, or the right words with a failing exit code.
  const printed = {
    settings: 'cat "$HOME/.fixture-vendor"/* 2>/dev/null',
    nothing: 'true',
    'settings-then-fail': 'cat "$HOME/.fixture-vendor"/* 2>/dev/null; exit 1'
  }[checkPrints]
  writeFileSync(join(bin, 'fixture-vendor'), `#!/bin/sh\n${printed}\n`)
  chmodSync(join(bin, 'fixture-vendor'), 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${savedPath}`
  const ctx = (profileFile, answer) => ({
    opts: { adoptProfile: profileFile },
    home,
    kitDir: join(home, '.agent-collab-kit'),
    currentPath: ROOT, // the skill's checker and the built-in catalog, read from this source tree
    node: { path: '/usr/bin/node' },
    serverPath: join(home, '.agent-collab-kit', 'current', 'collab', 'src', 'mcp', 'server.mjs'),
    ...(answer === undefined ? {} : { confirm: async () => answer })
  })
  return {
    base,
    home,
    ctx,
    adapter: join(home, '.agent-collab-kit', 'collab', 'adapters', 'fixture-vendor.json'),
    cleanup: () => { process.env.PATH = savedPath; rmSync(base, { recursive: true, force: true }) }
  }
}

function profile(registration, { mcpStatus = 'verified', id = 'fixture-vendor', binary = 'fixture-vendor' } = {}) {
  const none = { status: 'not_found', evidence: '' }
  return {
    id, vendor: 'xai', binary, version: '1.0',
    headless: { ...none }, readonly: { ...none }, config: { ...none }, hooks: { ...none }, auth: { ...none }, limits: { ...none },
    mcp: { status: mcpStatus, evidence: 'fixture-vendor mcp add wrote the entry in a temporary HOME; fixture-vendor mcp list showed it', ...(registration ? { registration } : {}) },
    models: [{ id: 'fixture-vendor-small', tier_guess: 'cheap', source: 'fixture-vendor --help' }]
  }
}

const JSON_REG = { kind: 'json-file', config_path: '~/.fixture-vendor/settings.json', servers_key: 'mcpServers', entry_extra: { timeout: 20 }, verify: { argv: ['fixture-vendor', 'mcp', 'list'], expect: 'COLLAB_AGENT_ID' } }
const writeProfile = (w, value) => {
  const file = join(w.base, 'profile.json')
  writeFileSync(file, JSON.stringify(value))
  return file
}
const backups = (w) => readdirSync(join(w.home, '.fixture-vendor')).filter((name) => name.includes('.backup-'))

test('json: after "да" the adapter is written, collab is merged in, the vendor\'s other settings stay, a backup is kept', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const settings = join(w.home, '.fixture-vendor', 'settings.json')
    writeFileSync(settings, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }, null, 2))
    const code = await lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true))
    assert.equal(code, 0)
    const written = JSON.parse(readFileSync(settings, 'utf8'))
    assert.equal(written.theme, 'dark')
    assert.deepEqual(written.mcpServers.other, { command: 'x' })
    assert.deepEqual(written.mcpServers.collab, { command: '/usr/bin/node', args: [w.ctx().serverPath], env: { COLLAB_AGENT_ID: 'fixture-vendor' }, timeout: 20 })
    const adapter = JSON.parse(readFileSync(w.adapter, 'utf8'))
    assert.deepEqual([adapter.id, adapter.provider, adapter.binary, adapter.registration.kind], ['fixture-vendor', 'xai', 'fixture-vendor', 'json-file'])
    assert.equal(backups(w).length, 1)
  } finally {
    w.cleanup()
  }
})

test('without "да", or without a terminal, nothing is written', { skip: skipWindows }, async () => {
  const w = world()
  try {
    const settings = join(w.home, '.fixture-vendor', 'settings.json')
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
    const settings = join(w.home, '.fixture-vendor', 'settings.json')
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
    const settings = join(w.home, '.fixture-vendor', 'config.toml')
    const before = '# mine\n[other]\na = 1\n'
    writeFileSync(settings, before)
    const reg = { ...JSON_REG, kind: 'toml-file', config_path: '~/.fixture-vendor/config.toml', servers_key: 'mcp_servers' }
    assert.equal(await lib.adoptProfile(w.ctx(writeProfile(w, profile(reg)), true)), 0)
    const text = readFileSync(settings, 'utf8')
    assert.ok(text.startsWith(before), 'what was there is kept as it was')
    assert.match(text, /\[mcp_servers\.collab\]\n# Managed by agent-collab-kit-install: machine adapter fixture-vendor/)
    assert.match(text, /env = \{ COLLAB_AGENT_ID = "fixture-vendor" \}\ntimeout = 20\n$/)
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
      ['out of the home', profile({ ...JSON_REG, config_path: '~/../etc/fixture-vendor.json' }), /config_path/],
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
    const evil = { id: 'evil', binary: 'sh', registration: { kind: 'json-file', config_path: '~/.fixture-vendor/evil.json', servers_key: 'mcpServers', verify: { argv: ['sh', '-c', `touch ${pwned}; echo collab`], expect: 'collab' } } }
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
    const settings = join(w.home, '.fixture-vendor', 'settings.json')
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
    rmSync(join(w.home, '.fixture-vendor'), { recursive: true })
    symlinkSync(outside, join(w.home, '.fixture-vendor'))
    await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, profile(JSON_REG)), true)), /resolves outside the home/)
    assert.deepEqual(readdirSync(outside), [], 'nothing written through the link')
    const cases = [
      ['built-in program', profile({ ...JSON_REG, verify: { argv: ['codex', 'mcp', 'list'], expect: 'collab' } }, { id: 'mycodex', binary: 'codex' }), /встроенный вендор/],
      ['id collab would not read', profile(JSON_REG, { id: '1' }), /\$\.id/],
      ['empty check', profile({ ...JSON_REG, verify: { argv: ['fixture-vendor', 'mcp', 'list'], expect: '\n' } }), /verify\.expect/]
    ]
    for (const [name, value, why] of cases) await assert.rejects(lib.adoptProfile(w.ctx(writeProfile(w, value), true)), why, name)
    assert.equal(existsSync(w.adapter), false)
  } finally {
    w.cleanup()
  }
})

// ── a vendor connected by one entry in the catalog (adapter.mcp_registration) ────────────────────────────────────────
// No adoption and no code of its own: the installer reads the catalog entry like an adopted adapter and writes collab by it.

function catalogWorld(entries) {
  const w = world()
  const current = join(w.base, 'current')
  mkdirSync(join(current, 'collab', 'config'), { recursive: true })
  writeFileSync(join(current, 'collab', 'config', 'agents.json'), JSON.stringify({ agents: entries }))
  const ctx = (extra = {}) => ({ ...w.ctx(), currentPath: current, ...extra })
  return { ...w, baseCtx: w.ctx, ctx }
}

const CATALOG_JSON = { id: 'fixture-vendor', detect: 'fixture-vendor', adapter: { kind: 'manual', mcp_registration: { kind: 'json-file', config_path: '~/.fixture-vendor/mcp.json', servers_key: 'mcp.servers' } } }
const CATALOG_TOML = { id: 'fixture-toml', detect: 'fixture-vendor', adapter: { kind: 'manual', mcp_registration: { kind: 'toml-file', config_path: '~/.fixture-vendor/config.toml', servers_key: 'mcp_servers' } } }

test('catalog: collab is written by the entry, a second run changes nothing, and an install that fails puts the file back', { skip: skipWindows }, () => {
  const w = catalogWorld([CATALOG_JSON])
  try {
    const file = join(w.home, '.fixture-vendor', 'mcp.json')
    writeFileSync(file, JSON.stringify({ theme: 'dark', mcp: { servers: { other: { command: 'x' } } } }))
    const original = readFileSync(file)
    const plan = lib.planAdapters(w.ctx())
    assert.equal(plan.items[0].changed, true)
    const journal = new lib.Journal()
    const changes = []
    lib.applyAdapters(w.ctx(), plan, journal, changes)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.mcp.servers.collab.env.COLLAB_AGENT_ID, 'fixture-vendor')
    assert.deepEqual(written.mcp.servers.other, { command: 'x' }, 'the vendor\'s other servers stay')
    assert.equal(written.theme, 'dark', 'and so do its other settings')
    assert.equal(lib.planAdapters(w.ctx()).items[0].changed, false, 'idempotent: nothing to do on the second run')
    journal.rollback()
    assert.ok(readFileSync(file).equals(original), 'rollback returns the file byte for byte')
  } finally {
    w.cleanup()
  }
})

test('catalog: toml is written in its own table', { skip: skipWindows }, () => {
  const w = catalogWorld([CATALOG_TOML])
  try {
    const file = join(w.home, '.fixture-vendor', 'config.toml')
    writeFileSync(file, 'model = "x"\n')
    lib.applyAdapters(w.ctx(), lib.planAdapters(w.ctx()), new lib.Journal(), [])
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^model = "x"$/m)
    assert.match(text, /^\[mcp_servers\.collab\]$/m)
    assert.match(text, /COLLAB_AGENT_ID = "fixture-toml"/)
  } finally {
    w.cleanup()
  }
})

test('catalog: a vendor nobody has here gets no settings file', { skip: skipWindows }, () => {
  const absent = { id: 'ghost-vendor', detect: 'ghost-vendor-cli', adapter: { kind: 'manual', mcp_registration: { kind: 'json-file', config_path: '~/.ghost-vendor/mcp.json', servers_key: 'mcpServers' } } }
  const w = catalogWorld([absent])
  try {
    const plan = lib.planAdapters(w.ctx())
    assert.equal(plan.items[0].skipped, true)
    lib.applyAdapters(w.ctx(), plan, new lib.Journal(), [])
    assert.equal(existsSync(join(w.home, '.ghost-vendor')), false)
  } finally {
    w.cleanup()
  }
})

test('catalog: an unusable entry stops the install by name, and a client the installer writes itself is never taken from the catalog', { skip: skipWindows }, () => {
  const outside = { ...CATALOG_JSON, adapter: { kind: 'manual', mcp_registration: { ...CATALOG_JSON.adapter.mcp_registration, config_path: '~/../elsewhere.json' } } }
  assert.throws(() => lib.planAdapters(catalogWorld([outside]).ctx()), /catalog agent fixture-vendor.*config_path/)
  const own = { id: 'cursor', detect: 'cursor', adapter: { kind: 'manual', mcp_registration: CATALOG_JSON.adapter.mcp_registration } }
  assert.throws(() => lib.planAdapters(catalogWorld([own]).ctx()), /registers with its own code/)
})

// ── review findings: one writer per file, a vendor's own directory, a check that is only `<vendor> mcp …` ──────────────

test('catalog: two entries for one file, or an entry for a file a built-in client owns, stop the install naming both', { skip: skipWindows }, () => {
  const same = { ...CATALOG_JSON, id: 'fixture-twin', detect: 'fixture-twin-cli' }
  assert.throws(() => lib.planAdapters(catalogWorld([CATALOG_JSON, same]).ctx()), /one file has one writer/)
  const w = catalogWorld([{ ...CATALOG_JSON, id: 'fixture-codex', adapter: { kind: 'manual', mcp_registration: { kind: 'toml-file', config_path: '~/.codex/config.toml', servers_key: 'mcp_servers' } } }])
  assert.throws(() => lib.planAdapters({ ...w.ctx(), codexConfig: join(w.home, '.codex', 'config.toml') }), /also written for codex/)
})

test('catalog: a shared directory is no proof the vendor is here — no file next to `~/.config` or in the home itself', { skip: skipWindows }, () => {
  const ghost = (config_path) => ({ id: 'ghost-vendor', detect: 'ghost-vendor-cli', adapter: { kind: 'manual', mcp_registration: { kind: 'json-file', config_path, servers_key: 'mcpServers' } } })
  for (const config_path of ['~/.config/ghost.json', '~/.ghost.json']) {
    const w = catalogWorld([ghost(config_path)])
    try {
      mkdirSync(join(w.home, '.config'), { recursive: true })
      const plan = lib.planAdapters(w.ctx())
      assert.equal(plan.items[0].skipped, true, config_path)
      lib.applyAdapters(w.ctx(), plan, new lib.Journal(), [])
      assert.equal(existsSync(join(w.home, config_path.slice(2))), false, `${config_path} was not created`)
    } finally {
      w.cleanup()
    }
  }
})

test('catalog: a vendor adopted as a machine adapter before the catalog knew it moves to the catalog, no double entry and no refusal', { skip: skipWindows }, async () => {
  const w = catalogWorld([CATALOG_JSON])
  try {
    assert.equal(await lib.adoptProfile(w.baseCtx(writeProfile(w, profile(JSON_REG)), true)), 0)
    const plan = lib.planAdapters(w.ctx())
    assert.equal(plan.items.length, 1, 'the vendor is planned once, from the catalog')
    assert.equal(plan.items[0].adapter.source, 'catalog')
  } finally {
    w.cleanup()
  }
})

test('catalog: a check that is not the vendor\'s own `mcp` command is refused (a program named rm passes argv[0] === binary), and entry_extra must be an object', { skip: skipWindows }, () => {
  const rm = { id: 'fixture-rm', detect: 'rm', adapter: { kind: 'manual', mcp_registration: { ...CATALOG_JSON.adapter.mcp_registration, verify: { argv: ['rm', '-v', '/tmp/victim'], expect: 'victim' } } } }
  assert.throws(() => lib.planAdapters(catalogWorld([rm]).ctx()), /mcp. subcommand/)
  for (const entry_extra of ['xy', 7, ['xy']]) {
    const bad = { ...CATALOG_JSON, adapter: { kind: 'manual', mcp_registration: { ...CATALOG_JSON.adapter.mcp_registration, entry_extra } } }
    assert.throws(() => lib.planAdapters(catalogWorld([bad]).ctx()), /entry_extra must be an object/, JSON.stringify(entry_extra))
  }
  const ok = { ...CATALOG_JSON, adapter: { kind: 'manual', mcp_registration: { ...CATALOG_JSON.adapter.mcp_registration, verify: { argv: ['fixture-vendor', 'mcp', 'list'], expect: 'collab' } } } }
  assert.doesNotThrow(() => lib.planAdapters(catalogWorld([ok]).ctx()))
})
