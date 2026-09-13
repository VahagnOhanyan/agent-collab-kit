// The MCP server, driven as a real child process over real bytes.
//
// This is the test that retires the risk of a hand-rolled transport. It spawns
// the server, writes newline-delimited JSON-RPC to its stdin and reads its
// stdout, so what is asserted is the wire behaviour a client will actually see —
// not an in-process function call that happens to share the same code.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TOOLS } from '../src/mcp/tools.mjs'
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'src', 'mcp', 'server.mjs')

// A tiny client: writes lines, resolves each response by id.
function startServer({ agentId = 'claude', stateDir }) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COLLAB_AGENT_ID: agentId, COLLAB_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const unsolicited = []
  let carry = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    carry += chunk
    let index = carry.indexOf('\n')
    while (index !== -1) {
      const line = carry.slice(0, index)
      carry = carry.slice(index + 1)
      if (line.trim()) {
        const message = JSON.parse(line)
        const resolve = pending.get(message.id)
        if (resolve) {
          pending.delete(message.id)
          resolve(message)
        } else {
          unsolicited.push(message)
        }
      }
      index = carry.indexOf('\n')
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d
  })

  return {
    child,
    stderr: () => stderr,
    unsolicited,
    request(id, method, params) {
      const answered = new Promise((resolve) => pending.set(id, resolve))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return answered
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
    raw(text) {
      child.stdin.write(text)
    },
    // Wait for the child to actually exit before the caller removes the state
    // directory: the server writes on its way out, and rmSync racing that
    // produces an ENOTEMPTY that has nothing to do with what is under test.
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.on('exit', resolve)
        child.stdin.end()
        child.kill()
      })
    }
  }
}

function scratch() {
  return mkdtempSync(join(tmpdir(), 'collab-mcp-'))
}

test('the full handshake, then tools/list and tools/call', async () => {
  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    const init = await server.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    })
    assert.equal(init.jsonrpc, '2.0')
    assert.equal(init.result.protocolVersion, '2025-06-18', 'a supported version is echoed back verbatim')
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
    assert.equal(init.result.serverInfo.name, 'aweiro-collab')
    assert.match(init.result.instructions, /request_user_approval/)

    server.notify('notifications/initialized')

    const listed = await server.request(2, 'tools/list')
    assert.equal(listed.result.tools.length, TOOLS.length)
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema must be an object schema`)
      assert.ok(tool.description.length > 40, `${tool.name}: description too short to guide a model`)
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name}: readOnlyHint`)
    }

    const who = await server.request(3, 'tools/call', { name: 'whoami', arguments: {} })
    assert.equal(who.result.isError, false)
    assert.equal(who.result.structuredContent.agent_id, 'claude')
    assert.deepEqual(who.result.structuredContent.roles, ['architect', 'ios_engineer', 'backend_engineer', 'product_engineer'])

    const pong = await server.request(4, 'ping')
    assert.deepEqual(pong.result, {}, 'ping answers with an empty object, not null')

    // The notification must not have produced a response of its own.
    assert.equal(server.unsolicited.length, 0, `server sent unsolicited output: ${JSON.stringify(server.unsolicited)}`)
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('every supported protocol version is echoed, an unknown one degrades', async () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const stateDir = scratch()
    const server = startServer({ stateDir })
    try {
      const init = await server.request(1, 'initialize', { protocolVersion: version })
      assert.equal(init.result.protocolVersion, version)
    } finally {
      await server.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }

  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    const init = await server.request(1, 'initialize', { protocolVersion: '2099-01-01' })
    assert.equal(init.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0], 'an unknown version gets our newest, not an error')
    assert.equal(init.error, undefined, 'initialize never errors over a version')
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an unknown method is -32601 and does not kill the server', async () => {
  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const missing = await server.request(2, 'resources/list')
    assert.equal(missing.error.code, -32601)
    assert.match(missing.error.message, /does not implement/)

    const alive = await server.request(3, 'ping')
    assert.deepEqual(alive.result, {})
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a malformed line is -32700 and the stream keeps working', async () => {
  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    server.raw('this is not json\n')
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(server.unsolicited.length, 1)
    assert.equal(server.unsolicited[0].error.code, -32700)

    const alive = await server.request(2, 'ping')
    assert.deepEqual(alive.result, {})
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a message split across writes is reassembled', async () => {
  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const answered = new Promise((resolve) => {
      const timer = setInterval(() => {
        if (server.unsolicited.length) {
          clearInterval(timer)
          resolve(server.unsolicited[0])
        }
      }, 20)
    })
    server.raw(payload.slice(0, 20))
    await new Promise((r) => setTimeout(r, 40))
    server.raw(`${payload.slice(20)}\n`)
    const message = await answered
    assert.equal(message.id, 1)
    assert.equal(message.result.serverInfo.name, 'aweiro-collab')
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a domain failure comes back as a tool error, never as a protocol error', async () => {
  const stateDir = scratch()
  const server = startServer({ stateDir })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const missing = await server.request(2, 'tools/call', { name: 'get_task', arguments: { task_id: 'tsk_zzzzzz_abcdef' } })
    assert.equal(missing.error, undefined, 'the JSON-RPC envelope is fine; the tool failed')
    assert.equal(missing.result.isError, true)
    assert.equal(JSON.parse(missing.result.content[0].text).code, 'NOT_FOUND')

    const unknown = await server.request(3, 'tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknown.result.isError, true)
    assert.equal(JSON.parse(unknown.result.content[0].text).code, 'UNKNOWN_TOOL')
  } finally {
    await server.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the server refuses to start without an identity', async () => {
  const stateDir = scratch()
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COLLAB_AGENT_ID: '', COLLAB_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  rmSync(stateDir, { recursive: true, force: true })
  assert.equal(code, 2, 'a config failure exits 2, like the aweiro adapter')
  assert.match(stderr, /COLLAB_AGENT_ID is required/)
})

test('the server refuses an identity that is not a registered agent', async () => {
  const stateDir = scratch()
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, COLLAB_AGENT_ID: 'nobody', COLLAB_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  rmSync(stateDir, { recursive: true, force: true })
  assert.equal(code, 2)
  assert.match(stderr, /no agent "nobody" is registered/)
})

test('NO EXPOSED TOOL CAN GRANT AN APPROVAL', () => {
  // The load-bearing safety property: an agent cannot authorise its own spending
  // because the tool to do it does not exist. This test is what keeps that true
  // when somebody adds a tool later.
  const names = TOOLS.map((t) => t.name)
  const forbidden = names.filter((n) => /^(grant|approve)|resolve_approval|consume_approval|deny_approval/.test(n))
  assert.deepEqual(forbidden, [], `these tool names would let an agent authorise itself: ${forbidden.join(', ')}`)
  assert.ok(names.includes('request_user_approval'), 'asking must be possible')
  assert.ok(names.includes('get_pending_approvals'), 'reading what is pending must be possible')

  // And no handler reaches the resolver, whatever it is called.
  for (const tool of TOOLS) {
    const source = tool.handler.toString()
    assert.ok(!/resolveApproval|consumeApproval/.test(source), `${tool.name} reaches the approval resolver`)
  }
})

test('destructive-sounding tools are annotated honestly', () => {
  for (const tool of TOOLS) {
    const mutates = /^(create|claim|assign|update|complete|block|release|send|reply|ack|request|submit|add|resolve|escalate|start)/.test(
      tool.name
    )
    assert.equal(
      tool.annotations.readOnlyHint,
      !mutates,
      `${tool.name}: readOnlyHint says ${tool.annotations.readOnlyHint} but the name says it ${mutates ? 'writes' : 'reads'}`
    )
  }
})
