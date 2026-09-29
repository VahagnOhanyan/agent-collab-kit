import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tempDir } from '../../collab/test/helpers.mjs'
import { readKitFiles } from '../kit-files.mjs'

test('kit file discovery reads frontmatter and reports malformed entries', () => {
  const root = tempDir('panel-kit-')
  mkdirSync(join(root, 'skills', 'valid'), { recursive: true })
  mkdirSync(join(root, 'skills', 'broken'), { recursive: true })
  mkdirSync(join(root, 'agents'))
  mkdirSync(join(root, 'rules'))
  writeFileSync(join(root, 'skills', 'valid', 'SKILL.md'), '---\nname: valid\ndescription: Works.\n---\n')
  writeFileSync(join(root, 'skills', 'broken', 'SKILL.md'), 'not frontmatter\n')
  writeFileSync(join(root, 'agents', 'helper.md'), '---\nname: helper\ndescription: Helps.\nmodel: small\ntools: Read, Grep\n---\n')
  writeFileSync(join(root, 'rules', 'neutral.md'), '# Neutral\n')

  const kit = readKitFiles(root)
  assert.deepEqual(kit.skills[1], { name: 'valid', description: 'Works.', path: 'skills/valid/SKILL.md' })
  assert.match(kit.skills[0].problem, /frontmatter/)
  assert.deepEqual(kit.agents[0].tools, ['Read', 'Grep'])
  assert.deepEqual(kit.rules, [{ name: 'neutral', path: 'rules/neutral.md' }])
})
