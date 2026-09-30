#!/usr/bin/env node
// The collaboration MCP server. Registered per agent with its own identity
// (COLLAB_AGENT_ID=claude for Claude Code, =codex for Codex), once per machine.
//
// ONE INSTALLATION, EVERY FOLDER. The server starts in whatever directory the
// client was opened in, so it must be harmless there: it never creates
// `.collab/`. Where there is no journal it still answers initialize and
// tools/list, and every tool call returns NOT_INITIALIZED (or ROOT_REFUSED for
// `/` and the home directory) naming the `collab init` to run. It re-checks on
// each call, so `collab init` takes effect without restarting the client.
// A bad identity or an invalid config still exits 2: those are not
// "wrong folder", they are a broken registration.
//
// stdout is the protocol channel. Every diagnostic goes to stderr, and
// console.log is reassigned to stderr at startup because one stray log line in
// the wrong stream is the single most common way a stdio MCP server dies.

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createApi, isUninitialised } from '../api.mjs'
import { ignoredEnv } from '../paths.mjs'
import { CollabError } from '../errors.mjs'
import { RPC, createFramer, encodeError, encodeResult } from './jsonrpc.mjs'
import { TOOLS } from './tools.mjs'

export const SERVER_NAME = 'collab'
export const SERVER_VERSION = '1.0.0'

// Echo back the client's version when we know it, otherwise offer our newest.
// Never error on initialize over a version: a client newer than this code should
// degrade, not fail.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const INSTRUCTIONS =
  'Shared task, message, review, decision and approval ledger for the agents working on this project. ' +
  'Start with whoami. When whoami names an owner_language, write everything the owner reads (titles, descriptions, ' +
  'summaries, messages, reviews and findings) in that language, as its write_for_owner says. ' +
  'Discover collaborators by ROLE or CAPABILITY (find_agents), never by name. ' +
  'Claim work before doing it and claim_files before editing, because the working tree is shared. ' +
  'Ask for an independent review with request_review — you may not review your own task. ' +
  'Anything that costs money, touches production, destroys data or handles credentials goes through ' +
  'request_user_approval and stops there: no tool here can grant one, only the owner can, at their terminal.'

function toolResult(payload, { isError = false } = {}) {
  const result = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError }
  if (!isError && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    result.structuredContent = payload
  }
  return result
}

// `api` is either a ready facade or a function returning one (which may throw
// NOT_INITIALIZED, reported as a tool error).
export function createHandler(api, { tools = TOOLS } = {}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const currentApi = typeof api === 'function' ? api : () => api

  return async function handle(method, params) {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS
        }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { title: tool.title, ...tool.annotations }
          }))
        }
      case 'tools/call': {
        const tool = byName.get(params?.name)
        if (!tool) {
          return toolResult({ code: 'UNKNOWN_TOOL', message: `there is no tool "${params?.name}"` }, { isError: true })
        }
        try {
          return toolResult(await tool.handler(params?.arguments ?? {}, currentApi()))
        } catch (error) {
          // A failed domain operation is a TOOL error the model can read and act
          // on, not a protocol error. Protocol errors are for malformed protocol.
          if (error instanceof CollabError) return toolResult(error.toJSON(), { isError: true })
          return toolResult(
            { code: 'INTERNAL_ERROR', message: error?.message || String(error), tool: tool.name },
            { isError: true }
          )
        }
      }
      default:
        return { __methodNotFound: true }
    }
  }
}

export function serve({ input = process.stdin, output = process.stdout, api, tools } = {}) {
  const handle = createHandler(api, { tools })
  const write = (line) => output.write(line)

  const framer = createFramer({
    onParseError: (error) => write(encodeError(null, RPC.PARSE_ERROR, `could not parse the message: ${error.message}`)),
    onMessage: async (message) => {
      const { id, method } = message
      // No id means a notification. A notification is NEVER answered — replying
      // to one desynchronises a client that is matching responses to requests.
      const isNotification = id === undefined || id === null
      if (isNotification) return

      if (typeof method !== 'string') {
        write(encodeError(id, RPC.INVALID_REQUEST, 'the message has no method'))
        return
      }
      try {
        const result = await handle(method, message.params)
        if (result && result.__methodNotFound) {
          write(encodeError(id, RPC.METHOD_NOT_FOUND, `this server does not implement "${method}"`))
          return
        }
        write(encodeResult(id, result))
      } catch (error) {
        write(encodeError(id, RPC.INTERNAL_ERROR, error?.message || String(error)))
      }
    }
  })

  input.setEncoding('utf8')
  input.on('data', (chunk) => framer.push(chunk))
  input.on('end', () => framer.end())
  return { framer, handle }
}

// `options` (configDir, registryDir, projectRoot) exist for tests only. The
// registered server is started without them, and no environment variable can
// stand in for them: a repository's .mcp.json can write this process's env.
export async function main(options = {}) {
  // Before anything else: keep stdout clean for the protocol.
  console.log = console.error
  console.info = console.error

  const trusted = Object.fromEntries(
    Object.entries({
      configDir: options.configDir,
      registryDir: options.registryDir,
      machineDir: options.machineDir,
      projectRoot: options.projectRoot
    }).filter(([, v]) => v)
  )
  const agentId = process.env.COLLAB_AGENT_ID
  let api = null
  let waiting = null
  try {
    api = createApi({ agentId, ...trusted })
  } catch (error) {
    if (!isUninitialised(error)) {
      process.stderr.write(`collab-mcp: ${error.message}\n`)
      process.exit(2)
    }
    waiting = error
  }

  const getApi = () => {
    if (!api) api = createApi({ agentId, ...trusted })
    return api
  }
  serve({ api: getApi })

  const goodbye = (status) => {
    if (!api) return
    try {
      api.store.emitUnlocked('agent.exit', { collection: 'agents', id: api.agentId }, { status })
    } catch {
      // Best effort on the way out; never block an exit on the ledger.
    }
  }
  process.on('SIGINT', () => {
    goodbye('offline')
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    goodbye('offline')
    process.exit(0)
  })
  process.stdin.on('end', () => {
    goodbye('offline')
    process.exit(0)
  })
  process.on('uncaughtException', (error) => {
    process.stderr.write(`collab-mcp: fatal ${error?.stack || error}\n`)
    goodbye('failed')
    process.exit(1)
  })

  process.stderr.write(
    api
      ? `collab-mcp ${SERVER_VERSION}: acting as ${api.agentId}, state in ${api.store.paths.root}, ${TOOLS.length} tools\n`
      : `collab-mcp ${SERVER_VERSION}: acting as ${agentId}, no journal yet (${waiting.code}): ${waiting.message}\n`
  )
  const ignored = ignoredEnv()
  if (ignored.length) process.stderr.write(`collab-mcp: ignoring ${ignored.join(', ')} — not runtime inputs\n`)
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (invokedDirectly) main()
