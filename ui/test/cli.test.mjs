import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cleanEnv, CLI, runCli, tempDir } from '../../collab/test/helpers.mjs'
import { get } from '../test-helpers.mjs'

test('collab ui prints a token URL and exits cleanly on SIGTERM', async (t) => {
  const base = tempDir('panel-cli-')
  const launcher = join(base, 'launcher.mjs')
  writeFileSync(
    launcher,
    `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)}\nawait main(process.argv.slice(2), ${JSON.stringify({ registryDir: join(base, 'registry'), machineDir: join(base, 'machine'), projectRoot: base })})\n`
  )
  const child = spawn(process.execPath, [launcher, 'ui', '--port', '0', '--no-open'], {
    cwd: base,
    env: cleanEnv({ HOME: join(base, 'home') }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no URL from collab ui: ${stderr}`)), 2000)
    child.stdout.on('data', () => {
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]{48}/)
      if (!match) return
      clearTimeout(timeout)
      resolve(match[0])
    })
    child.on('exit', (code) => {
      if (code === 1 && /listen EPERM: operation not permitted 127\.0\.0\.1/.test(stderr)) {
        clearTimeout(timeout)
        t.skip(`sandbox refused 127.0.0.1 listen: ${stderr.split('\n')[0]}`)
        resolve(null)
        return
      }
      reject(new Error(`collab ui exited ${code}: ${stderr}`))
    })
  })
  if (!url) return
  const parsed = new URL(url)
  const token = parsed.searchParams.get('t')
  const fakePanel = { server: { address: () => ({ port: Number(parsed.port) }) } }
  assert.equal((await get(fakePanel, '/', { token })).status, 200)
  child.kill('SIGTERM')
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(exit, { code: 0, signal: null })
})

test('collab ui rejects unsupported flags before opening a socket', () => {
  const base = tempDir('panel-cli-invalid-')
  const result = runCli(['ui', '--execute'], { cwd: base, options: { registryDir: join(base, 'registry'), machineDir: join(base, 'machine') } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /INVALID_INPUT usage: collab ui/)
  assert.doesNotMatch(result.stderr, /node:net/)
})

test('help adds exactly the collab ui command line', () => {
  const result = runCli(['help'], { cwd: tempDir('panel-help-') })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.split('\n').filter((line) => /\bui \[--port N\]/.test(line)).length, 1)
})
