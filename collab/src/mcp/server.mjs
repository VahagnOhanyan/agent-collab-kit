#!/usr/bin/env node
// The collaboration MCP server. Registered per agent with its own identity:
//   .mcp.json            -> COLLAB_AGENT_ID=claude
//   ~/.codex/config.toml -> COLLAB_AGENT_ID=codex
//
// stdout is the protocol channel. Every diagnostic goes to stderr, and
// console.log is reassigned to stderr at startup because one stray log line in
// the wrong stream is the single most common way a stdio MCP server dies.

import { createApi } from '../api.mjs'
import { CollabError } from '../errors.mjs'
import { RPC, createFramer, encodeError, encodeResult } from './jsonrpc.mjs'
import { TOOLS } from './tools.mjs'

export const SERVER_NAME = 'aweiro-collab'
export const SERVER_VERSION = '1.0.0'

// Echo back the client's version when we know it, otherwise offer our newest.
// Never error on initialize over a version: a client newer than this code should
// degrade, not fail.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const INSTRUCTIONS =
  'Shared task, message, review, decision and approval ledger for the agents working on this repository. ' +
  'Start with whoami. Discover collaborators by ROLE or CAPABILITY (find_agents), never by name. ' +
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

export function createHandler(api, { tools = TOOLS } = {}) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

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
          return toolResult(await tool.handler(params?.arguments ?? {}, api))
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

async function main() {
  // Before anything else: keep stdout clean for the protocol.
  console.log = console.error
  console.info = console.error

  let api
  try {
    api = createApi({ agentId: process.env.COLLAB_AGENT_ID })
  } catch (error) {
    process.stderr.write(`collab-mcp: ${error.message}\n`)
    process.exit(2)
  }

  serve({ api })

  const goodbye = (status) => {
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
    `collab-mcp ${SERVER_VERSION}: acting as ${api.agentId}, state in ${api.store.paths.root}, ${TOOLS.length} tools\n`
  )
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) main()
