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

test('mcp discovery lists user-level servers of both agents, skips project files and never leaks secrets', () => {
  const home = tempDir('panel-home-')
  mkdirSync(join(home, '.codex'))
  mkdirSync(join(home, '.claude-two'))
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      collab: { command: '/bin/node', args: ['--token=SECRET'], env: { KEY: 'SECRET' } },
      docs: { type: 'http', url: 'https://docs.example/mcp?key=SECRET', headers: { Authorization: 'SECRET' } }
    },
    projects: { '/p': { mcpServers: { only_here: { command: 'x' } } } }
  }))
  writeFileSync(join(home, '.claude-two', '.claude.json'), JSON.stringify({ mcpServers: { collab: { command: '/bin/node' } } }))
  writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.collab]\ncommand = "/bin/node"\n[mcp_servers.collab.env]\nKEY = "SECRET"\n[mcp_servers.linear]\nurl = "https://linear.example/mcp"\n')
  mkdirSync(join(home, 'work'))
  writeFileSync(join(home, 'work', '.mcp.json'), JSON.stringify({ mcpServers: { project_only: { command: 'node' } } }))

  const kit = readKitFiles(tempDir('panel-empty-'), { home })
  assert.deepEqual(kit.mcp.map(({ commands, ...row }) => row), [
    { name: 'collab', transport: 'stdio', target: 'node', agents: ['claude', 'codex'] },
    { name: 'docs', transport: 'http', target: 'https://docs.example/mcp', agents: ['claude'] },
    { name: 'linear', transport: 'http', target: 'https://linear.example/mcp', agents: ['codex'] }
  ])
  // Commands to add a server go to the vendors that lack it; collab is the installer's, never offered.
  assert.deepEqual(kit.mcp.map((row) => [row.name, Object.keys(row.commands).sort()]), [
    ['collab', []],
    ['docs', ['codex', 'cursor', 'gemini']],
    ['linear', ['claude', 'cursor', 'gemini']]
  ])
  assert.doesNotMatch(JSON.stringify(kit), /SECRET/)
})

test('mcp discovery lists a server registered for the selected project only, without add-commands', () => {
  const home = tempDir('panel-home-')
  mkdirSync(join(home, '.agent-collab-kit', 'state'), { recursive: true })
  const entry = (dir) => ({ dir, root: '/p', name: 'sentry', url: 'https://mcp.sentry.dev/mcp/org', project: 'my-app' })
  writeFileSync(join(home, '.agent-collab-kit', 'state', 'project-mcp.json'), JSON.stringify({ version: 1, registrations: [entry('/a'), entry('/b')] }))

  assert.deepEqual(readKitFiles(tempDir('panel-empty-'), { home, project: 'other' }).mcp, [])
  assert.deepEqual(readKitFiles(tempDir('panel-empty-'), { home }).mcp, [])
  const kit = readKitFiles(tempDir('panel-empty-'), { home, project: 'my-app' })
  assert.deepEqual(kit.mcp, [{ name: 'sentry', transport: 'http', target: 'https://mcp.sentry.dev/mcp/org', agents: ['claude'], commands: {}, project: 'my-app' }])
})
