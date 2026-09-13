// Newline-delimited JSON-RPC 2.0 over stdio. No dependencies, on purpose.
//
// WHY NOT @modelcontextprotocol/sdk. It is a dependency of backend/ only. Using
// it here would mean either a second node_modules under tools/collab/ or an
// import reaching into ../../backend/node_modules — and in a fresh clone, before
// anyone runs `npm ci`, that is an MCP server that dies on startup and shows up
// in the client as broken. Every one of this repo's 21 guard scripts runs on
// bare `node` for the same reason. The surface actually needed here is five
// methods, one of which is a no-op.
//
// The risk of hand-rolling is a subtly wrong handshake, and that risk is retired
// by test/mcp.test.mjs, which spawns this server as a real child process and
// drives real bytes through it. Reconsider the trade only if this server ever
// needs resources, prompts, sampling or server-initiated progress.
//
// FRAMING RULES, each of which is a real bug if dropped:
//   - one message per line; JSON.stringify never emits a bare newline, so
//     splitting on '\n' is safe in both directions;
//   - keep a carry buffer, because a message can straddle a chunk;
//   - setEncoding('utf8') so a multi-byte character never splits mid-glyph;
//   - a message with no `id` is a NOTIFICATION and must NEVER be answered.
//     Answering one is the classic way a hand-rolled server desynchronises a
//     client that is counting responses.

export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
})

export const MAX_LINE_BYTES = 8 * 1024 * 1024

export function createFramer({ onMessage, onParseError, maxLineBytes = MAX_LINE_BYTES }) {
  let carry = ''
  return {
    push(chunk) {
      carry += chunk
      if (carry.length > maxLineBytes) {
        carry = ''
        onParseError(new Error(`line exceeded ${maxLineBytes} bytes`))
        return
      }
      let index = carry.indexOf('\n')
      while (index !== -1) {
        const line = carry.slice(0, index)
        carry = carry.slice(index + 1)
        if (line.trim()) {
          try {
            onMessage(JSON.parse(line))
          } catch (error) {
            onParseError(error)
          }
        }
        index = carry.indexOf('\n')
      }
    },
    end() {
      carry = ''
    }
  }
}

export const encodeResult = (id, result) => `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`

export const encodeError = (id, code, message, data) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })}\n`
