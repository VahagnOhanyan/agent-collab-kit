// Known vendor CLIs found on the machine without an adapter: a PATH lookup against the catalog, with the sentence to
// give that agent. A registered vendor is never named; a missing skill is nothing to report, not a failure.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadBuiltinAgents } from '../src/registry.mjs'
import { unadaptedVendors } from '../src/vendors.mjs'
import { tempDir } from './helpers.mjs'

const skipWindows = process.platform === 'win32'

function machine() {
  const base = tempDir('collab-vendors-')
  const bin = join(base, 'bin')
  mkdirSync(bin)
  for (const name of ['agy', 'grok']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, name), 0o755)
  }
  return { base, bin, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('a known CLI on PATH that the catalog lacks is named, with the sentence for that agent; a registered one is not', { skip: skipWindows }, async () => {
  const m = machine()
  try {
    const agentsFile = join(m.base, 'agents.json')
    const none = join(m.base, 'no-adapters')
    writeFileSync(agentsFile, JSON.stringify({ agents: [{ id: 'grok-agent', adapter: { binary: 'grok' } }] }))
    const found = await unadaptedVendors({ agentsFile, adaptersDir: none, env: { PATH: m.bin } })
    assert.deepEqual(found.map((v) => [v.binary, v.vendor, v.path]), [['agy', 'google', join(m.bin, 'agy')]])
    // grok unregistered: an ordinary vendor without an adapter gets the reconnaissance sentence.
    writeFileSync(agentsFile, JSON.stringify({ agents: [] }))
    const grok = (await unadaptedVendors({ agentsFile, adaptersDir: none, env: { PATH: m.bin } })).find((v) => v.binary === 'grok')
    assert.match(grok.phrase, /vendor-probe\/SKILL\.md/)
    assert.match(grok.phrase, /для grok/)
    assert.match(grok.phrase, /только после моего «да»/)
    assert.equal(grok.advice, null)
  } finally {
    m.cleanup()
  }
})

// agy's MCP settings are the installer's own Gemini client: a machine adapter for it is refused, so the kit must not
// send the owner to reconnaissance that leads nowhere — it says what does work instead.
test('a vendor the installer already connects gets advice, not a reconnaissance sentence', { skip: skipWindows }, async () => {
  const m = machine()
  try {
    const agentsFile = join(m.base, 'agents.json')
    writeFileSync(agentsFile, JSON.stringify({ agents: [] }))
    const agy = (await unadaptedVendors({ agentsFile, adaptersDir: join(m.base, 'no-adapters'), env: { PATH: m.bin } })).find((v) => v.binary === 'agy')
    assert.equal(agy.installer_client, 'gemini')
    assert.equal(agy.phrase, null)
    assert.match(agy.advice, /клиент gemini/)
    assert.match(agy.advice, /встроенный каталог/)
  } finally {
    m.cleanup()
  }
})

test('nothing on PATH, nothing named; no skill in the install, nothing named and no failure', async () => {
  const m = machine()
  try {
    const agentsFile = join(m.base, 'agents.json')
    writeFileSync(agentsFile, JSON.stringify({ agents: [] }))
    assert.deepEqual(await unadaptedVendors({ agentsFile, env: { PATH: join(m.base, 'empty') } }), [])
    assert.deepEqual(await unadaptedVendors({ agentsFile, probeFile: join(m.base, 'no-such', 'probe.mjs'), env: { PATH: m.bin } }), [])
  } finally {
    m.cleanup()
  }
})

test('an adopted vendor joins the catalog the wizard offers and is no longer named as without an adapter', { skip: skipWindows }, async () => {
  const m = machine()
  try {
    const machineDir = join(m.base, 'machine')
    mkdirSync(join(machineDir, 'adapters'), { recursive: true })
    const adapter = { id: 'grok', provider: 'xai', binary: 'grok', registration: { kind: 'json-file' } }
    // As agent-collab-kit-install --adopt-profile writes it: the file and the owner's approval mark beside it.
    const approved = (name, value) => {
      const file = join(machineDir, 'adapters', name)
      writeFileSync(file, JSON.stringify(value))
      writeFileSync(`${file}.approved`, `${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`)
    }
    approved('grok.json', adapter)
    // A built-in id, a file whose name does not match its id, and an adapter without approval are not taken.
    approved('claude.json', { ...adapter, id: 'claude', binary: 'claude' })
    approved('other.json', { ...adapter, id: 'mismatch' })
    writeFileSync(join(machineDir, 'adapters', 'unapproved.json'), JSON.stringify({ ...adapter, id: 'unapproved', binary: 'unapproved' }))
    writeFileSync(join(machineDir, 'adapters', 'broken.json'), '{ not json')
    const catalog = loadBuiltinAgents(machineDir).agents
    const grok = catalog.find((a) => a.id === 'grok')
    assert.ok(grok, 'grok is in the catalog')
    assert.deepEqual([grok.provider, grok.detect, grok.adapter.kind, grok.machine_adapter], ['xai', 'grok', 'manual', true])
    assert.ok(grok.roles.length && grok.capabilities.length, 'it gets roles and capabilities like any catalog agent, to be cut by facts')
    assert.equal(catalog.filter((a) => a.id === 'claude').length, 1, 'the built-in claude wins')
    assert.equal(catalog.some((a) => a.id === 'mismatch'), false)
    assert.equal(catalog.some((a) => a.id === 'unapproved'), false, 'an adapter nobody approved is not offered')
    const agentsFile = join(m.base, 'agents.json')
    writeFileSync(agentsFile, JSON.stringify({ agents: [] }))
    const named = await unadaptedVendors({ agentsFile, adaptersDir: join(machineDir, 'adapters'), env: { PATH: m.bin } })
    assert.deepEqual(named.map((v) => v.binary), ['agy'], 'grok has an adapter now; agy still has none')
  } finally {
    m.cleanup()
  }
})
