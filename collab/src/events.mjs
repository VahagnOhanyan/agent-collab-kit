// Append-only audit log. Every mutation lands here, and this file is the answer
// to "what actually happened" when two agents remember it differently.
//
// ATOMICITY. Every append in normal operation happens inside the store mutex,
// so serialisation is already guaranteed by the mutex — that is the first line
// of defence and the one to rely on. O_APPEND (the 'a' flag) is the second:
// under it the kernel assigns the write offset, so two processes appending
// concurrently cannot land on the same bytes. It is here for any future path
// that appends without the lock, such as a crash handler.
//
// ⛔ Do not read the O_APPEND paragraph as permission to drop the mutex.
// O_APPEND gives non-interleaved bytes; it does not give a serialised
// read-modify-write, which is what a version bump is.
//
// Lines are capped so one append stays one write(2) with a wide margin. An
// oversized payload is truncated with a marker rather than dropped: a truncated
// audit line still tells you the event happened.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

export const MAX_EVENT_BYTES = 16 * 1024

function clampPayload(event) {
  const line = JSON.stringify(event)
  if (line.length <= MAX_EVENT_BYTES) return line
  const trimmed = {
    ...event,
    data: { truncated: true, note: `payload dropped, was ${line.length} bytes` }
  }
  return JSON.stringify(trimmed)
}

export function appendEvent(eventsFile, event) {
  const line = clampPayload(event)
  appendFileSync(eventsFile, `${line}\n`, 'utf8')
  return event
}

export function readEvents(eventsFile, { limit = 100, since = null, filter = null } = {}) {
  if (!existsSync(eventsFile)) return []
  const lines = readFileSync(eventsFile, 'utf8').split('\n')
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // A corrupt line is worth surfacing rather than hiding: the log is the
      // thing you consult when you already do not trust your picture.
      out.push({ ts: null, type: 'log.unparseable', data: { line: line.slice(0, 200) } })
      continue
    }
    if (since && event.ts && event.ts < since) continue
    if (filter && !filter(event)) continue
    out.push(event)
  }
  return limit > 0 ? out.slice(-limit) : out
}
