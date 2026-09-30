// The MCP server, driven as a real child process over real bytes.
//
// This is the test that retires the risk of a hand-rolled transport. It spawns
// the server, writes newline-delimited JSON-RPC to its stdin and reads its
// stdout, so what is asserted is the wire behaviour a client will actually see —
// not an in-process function call that happens to share the same code.
// Sandbox roots and config reach the server as main() parameters (helpers.mjs),
// never as environment variables.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { TOOLS } from '../src/mcp/tools.mjs'
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/server.mjs'
import { homeEnv, runCli, sandbox, startServer, tempDir, toolPayload } from './helpers.mjs'

// A server inside an initialised sandbox project.
const serverIn = (sbx, extra = {}) => startServer({ cwd: sbx.root, options: sbx.options, ...extra })

test('the full handshake, then tools/list and tools/call', async () => {
  const sbx = sandbox()
  const server = serverIn(sbx)
  try {
    const init = await server.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    })
    assert.equal(init.jsonrpc, '2.0')
    assert.equal(init.result.protocolVersion, '2025-06-18', 'a supported version is echoed back verbatim')
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
    assert.equal(init.result.serverInfo.name, 'collab')
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
    assert.equal(who.result.structuredContent.journal_root, sbx.root)

    const pong = await server.request(4, 'ping')
    assert.deepEqual(pong.result, {}, 'ping answers with an empty object, not null')

    // The notification must not have produced a response of its own.
    assert.equal(server.unsolicited.length, 0, `server sent unsolicited output: ${JSON.stringify(server.unsolicited)}`)
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

test('in a folder with no journal: the handshake works, every tool call is NOT_INITIALIZED, nothing is created, and init takes effect without a restart', async () => {
  const base = tempDir('collab-mcp-bare-')
  const options = { registryDir: join(base, 'registry') }
  const server = startServer({ cwd: base, options })
  try {
    const init = await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    assert.equal(init.result.serverInfo.name, 'collab')
    const listed = await server.request(2, 'tools/list')
    assert.equal(listed.result.tools.length, TOOLS.length, 'the tools are listed so the client can show them')

    let id = 10
    for (const name of ['whoami', 'collab_status', 'list_tasks', 'create_task']) {
      const response = await server.request((id += 1), 'tools/call', { name, arguments: name === 'create_task' ? { title: 'nope' } : {} })
      assert.equal(response.error, undefined, `${name}: a tool error, not a protocol error`)
      assert.equal(response.result.isError, true, name)
      const body = toolPayload(response)
      assert.equal(body.code, 'NOT_INITIALIZED', name)
      assert.match(body.message, /collab init/)
      assert.equal(body.details.command, 'collab init')
    }
    assert.equal(existsSync(join(base, '.collab')), false, 'the server created nothing')

    const created = runCli(['init'], { cwd: base, options })
    assert.equal(created.status, 0, created.stderr)

    const who = await server.request(50, 'tools/call', { name: 'whoami', arguments: {} })
    assert.equal(who.result.isError, false, JSON.stringify(who.result))
    assert.equal(who.result.structuredContent.journal_root, base)
  } finally {
    await server.stop()
    rmSync(base, { recursive: true, force: true })
  }
})

test('a session opened where the root resolves to the home directory gets ROOT_REFUSED, and the server stays up', async () => {
  const home = tempDir('collab-mcp-home-')
  mkdirSync(join(home, '.collab'))
  mkdirSync(join(home, 'Desktop'))
  const server = startServer({ cwd: join(home, 'Desktop'), env: homeEnv(home), options: { registryDir: join(home, 'registry') } })
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const who = await server.request(2, 'tools/call', { name: 'whoami', arguments: {} })
    assert.equal(who.result.isError, true)
    assert.equal(toolPayload(who).code, 'ROOT_REFUSED')
    assert.deepEqual((await server.request(3, 'ping')).result, {})
  } finally {
    await server.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('every supported protocol version is echoed, an unknown one degrades', async () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const sbx = sandbox()
    const server = serverIn(sbx)
    try {
      const init = await server.request(1, 'initialize', { protocolVersion: version })
      assert.equal(init.result.protocolVersion, version)
    } finally {
      await server.stop()
      sbx.cleanup()
    }
  }

  const sbx = sandbox()
  const server = serverIn(sbx)
  try {
    const init = await server.request(1, 'initialize', { protocolVersion: '2099-01-01' })
    assert.equal(init.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0], 'an unknown version gets our newest, not an error')
    assert.equal(init.error, undefined, 'initialize never errors over a version')
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

test('an unknown method is -32601 and does not kill the server', async () => {
  const sbx = sandbox()
  const server = serverIn(sbx)
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const missing = await server.request(2, 'resources/list')
    assert.equal(missing.error.code, -32601)
    assert.match(missing.error.message, /does not implement/)

    const alive = await server.request(3, 'ping')
    assert.deepEqual(alive.result, {})
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

test('a malformed line is -32700 and the stream keeps working', async () => {
  const sbx = sandbox()
  const server = serverIn(sbx)
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
    sbx.cleanup()
  }
})

test('a message split across writes is reassembled', async () => {
  const sbx = sandbox()
  const server = serverIn(sbx)
  try {
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const answered = new Promise((resolve) => {
      const timer = setInterval(() => {
        if (server.unsolicited.length) {
          clearInterval(timer)
          resolve(server.unsolicited[0])
        }
      }, 20)
    })
    server.raw(message.slice(0, 20))
    await new Promise((r) => setTimeout(r, 40))
    server.raw(`${message.slice(20)}\n`)
    const response = await answered
    assert.equal(response.id, 1)
    assert.equal(response.result.serverInfo.name, 'collab')
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

test('a domain failure comes back as a tool error, never as a protocol error', async () => {
  const sbx = sandbox()
  const server = serverIn(sbx)
  try {
    await server.request(1, 'initialize', { protocolVersion: '2025-06-18' })
    const missing = await server.request(2, 'tools/call', { name: 'get_task', arguments: { task_id: 'tsk_zzzzzz_abcdef' } })
    assert.equal(missing.error, undefined, 'the JSON-RPC envelope is fine; the tool failed')
    assert.equal(missing.result.isError, true)
    assert.equal(toolPayload(missing).code, 'NOT_FOUND')

    const unknown = await server.request(3, 'tools/call', { name: 'nope', arguments: {} })
    assert.equal(unknown.result.isError, true)
    assert.equal(toolPayload(unknown).code, 'UNKNOWN_TOOL')
  } finally {
    await server.stop()
    sbx.cleanup()
  }
})

async function exitOf(server) {
  const code = await new Promise((resolve) => {
    if (server.child.exitCode !== null) return resolve(server.child.exitCode)
    server.child.on('exit', resolve)
  })
  return { code, stderr: server.stderr() }
}

test('the server refuses to start without an identity', async () => {
  const sbx = sandbox()
  try {
    const { code, stderr } = await exitOf(serverIn(sbx, { agentId: '' }))
    assert.equal(code, 2, 'a config failure exits 2')
    assert.match(stderr, /COLLAB_AGENT_ID is required/)
  } finally {
    sbx.cleanup()
  }
})

test('the server refuses an identity that is not a registered agent — even where there is no journal', async () => {
  const sbx = sandbox({ init: false })
  try {
    const { code, stderr } = await exitOf(serverIn(sbx, { agentId: 'nobody' }))
    assert.equal(code, 2)
    assert.match(stderr, /no agent "nobody" is registered/)
    assert.equal(existsSync(sbx.stateDir), false)
  } finally {
    sbx.cleanup()
  }
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
    const mutates = /^(create|claim|assign|update|complete|block|release|send|reply|ack|request|submit|add|resolve|escalate|start|suspend)/.test(
      tool.name
    )
    assert.equal(
      tool.annotations.readOnlyHint,
      !mutates,
      `${tool.name}: readOnlyHint says ${tool.annotations.readOnlyHint} but the name says it ${mutates ? 'writes' : 'reads'}`
    )
  }
})
