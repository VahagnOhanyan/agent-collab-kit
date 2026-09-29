import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli, tempDir } from '../../collab/test/helpers.mjs'
import { detectSetup, previewSetup } from '../setup-wizard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

test('M5 setup preview refuses unknown agents, invalid leads and shell metacharacters', () => {
  const common = { registryDir: join(tempDir(), 'registry'), machineDir: join(tempDir(), 'machine'), cwd: tempDir() }
  for (const agents of [['unknown-agent'], ['a; rm -rf ~'], ['$(x)'], ['has space']]) {
    assert.equal(previewSetup({ ...common, agents, lead: agents[0], singleVendor: '0' }).ok, false, agents[0])
  }
  const catalog = detectSetup(common).catalog
  assert.ok(catalog.length >= 2)
  assert.equal(previewSetup({ ...common, agents: [catalog[0].id], lead: catalog[1].id, singleVendor: '0' }).ok, false)
  assert.equal(previewSetup({ ...common, agents: [catalog[0].id], lead: catalog[0].id, singleVendor: 'yes' }).ok, false)
})

test('M9 public scripts contain no HTML injection or eval sinks', () => {
  const dir = join(ROOT, 'ui', 'public')
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    const source = readFileSync(join(dir, name), 'utf8')
    assert.doesNotMatch(source, /\binnerHTML\b|\binsertAdjacentHTML\b|\beval\s*\(/, name)
  }
})

test('M10 setup preview command is accepted by the real setup parser', () => {
  const base = tempDir('panel-setup-')
  const common = { registryDir: join(base, 'registry'), machineDir: join(base, 'machine'), cwd: base }
  const catalog = detectSetup(common).catalog
  assert.ok(catalog.length >= 2)
  const answer = previewSetup({ ...common, agents: [catalog[0].id, catalog[1].id], lead: catalog[0].id, singleVendor: '0' })
  assert.equal(answer.ok, true)
  const setup = answer.commands.find((entry) => entry.command.startsWith('collab setup '))
  assert.ok(setup)
  assert.doesNotMatch(setup.command, /[;$()`~]/)
  const argv = setup.command.split(' ').slice(1).concat('--dry-run')
  const result = runCli(argv, { cwd: base, options: { registryDir: common.registryDir, machineDir: common.machineDir } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /dry run — nothing written/)
})
