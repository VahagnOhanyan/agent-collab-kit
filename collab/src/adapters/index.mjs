// How a message physically reaches an agent.
//
// The adapter is the ONLY place that knows anything provider-specific, and it
// knows only two things: whether the agent can be reached right now, and how.
// Everything above it — tasks, reviews, routing — works in roles and
// capabilities and would not change if a fourth provider appeared.
//
// Adding an agent means adding an entry to config/agents.json. Adding a NEW KIND
// of agent means one more file here implementing probe/deliver/describe. Two
// kinds cover both current agents and, in practice, most future ones:
//
//   manual — the message waits in the inbox; the agent reads it when its own
//            session runs. This is how Claude Code and any interactive session
//            works, and it is the default because it costs nothing and starts
//            nothing.
//   cli    — the layer COULD spawn the agent. Whether it does is `enabled`, and
//            it is false: the owner decided on 2026-09-10 that nothing starts a
//            paid agent without them. probe() still reports whether the binary
//            is there, so `collab doctor` tells the truth about what is possible
//            rather than what is configured.

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { manualAdapter } from './manual.mjs'
import { cliAdapter } from './cli.mjs'

const IS_WINDOWS = process.platform === 'win32'
const PATHEXT = Object.freeze(
  (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
)

function isExecutableFile(p) {
  try {
    const st = statSync(p)
    return st.isFile() && (IS_WINDOWS || (st.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

// Windows has no `/bin/sh` and no chmod-executable-bit convention — an
// npm-installed agent CLI (codex, agy, …) there ships as a bare-name .cmd
// shim, found the same way cmd.exe itself would: each PATHEXT extension in
// turn, over each PATH directory.
function whichWindows(binary) {
  const lower = binary.toLowerCase()
  const names = PATHEXT.some((ext) => lower.endsWith(ext)) ? [binary] : [binary, ...PATHEXT.map((ext) => binary + ext)]
  for (const dir of (process.env.PATH || process.env.Path || '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

export function which(binary) {
  if (IS_WINDOWS) return whichWindows(binary)
  try {
    // /bin/sh by absolute path: the shell itself is never looked up on PATH. The
    // lookup of `binary` does use the caller's PATH on purpose — the question is
    // whether the owner can start that agent from their own shell.
    return execFileSync('/bin/sh', ['-c', `command -v ${JSON.stringify(binary)}`], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

export function adapterFor(agentView) {
  const adapter = agentView.adapter || { kind: 'manual' }
  switch (adapter.kind) {
    case 'cli':
      return cliAdapter(agentView, adapter)
    case 'manual':
    default:
      return manualAdapter(agentView, adapter)
  }
}
