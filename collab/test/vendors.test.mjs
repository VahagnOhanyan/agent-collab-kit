// Known vendor CLIs found on the machine without an adapter: a PATH lookup against the catalog, with the sentence to
// give that agent. A registered vendor is never named; a missing skill is nothing to report, not a failure.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
    writeFileSync(agentsFile, JSON.stringify({ agents: [{ id: 'grok-agent', adapter: { binary: 'grok' } }] }))
    const found = await unadaptedVendors({ agentsFile, env: { PATH: m.bin } })
    assert.deepEqual(found.map((v) => [v.binary, v.vendor, v.path]), [['agy', 'google', join(m.bin, 'agy')]])
    assert.match(found[0].phrase, /vendor-probe\/SKILL\.md/)
    assert.match(found[0].phrase, /для agy/)
    assert.match(found[0].phrase, /только после моего «да»/)
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
