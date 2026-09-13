// An agent the layer could start as a subprocess.
//
// deliver() refuses unless `enabled` is true in config/agents.json, and it is
// false by owner decision (2026-09-10): queue first, launch by hand. Spawning a
// metered agent is spending, and §12 of this layer's own contract says an agent
// does not spend on its own. The code exists so switching the flag is the whole
// change; the flag exists so nobody switches it by accident.
//
// probe() reports the binary honestly whether or not launching is enabled, so
// `collab doctor` distinguishes "not installed" from "installed, not allowed".

import { spawn } from 'node:child_process'
import { which } from './index.mjs'

export function cliAdapter(agentView, adapter) {
  const resolve = () => which(adapter.binary)

  return {
    kind: 'cli',
    describe: () => ({
      kind: 'cli',
      binary: adapter.binary,
      autostart: adapter.enabled === true,
      how:
        adapter.enabled === true
          ? `the layer may run \`${adapter.binary}\` to deliver work`
          : `messages wait in the inbox; \`${adapter.binary}\` is started by the owner`
    }),

    probe() {
      const path = resolve()
      if (!path) {
        return {
          reachable: false,
          how: 'inbox only',
          missing: adapter.binary,
          note: `\`${adapter.binary}\` is not on PATH, so this agent cannot be started from here`,
          fix: adapter.install_hint || `install ${adapter.binary} and re-run: collab doctor`
        }
      }
      return {
        reachable: true,
        how: adapter.enabled === true ? 'cli' : 'inbox (autostart off)',
        binary_path: path,
        note:
          adapter.enabled === true
            ? 'the layer may start this agent'
            : `installed, but autostart is off: ${adapter.note || 'owner decision'}`
      }
    },

    deliver({ prompt, cwd }) {
      if (adapter.enabled !== true) {
        return {
          delivered: 'queued',
          detail:
            `autostart is off for ${agentView.id}. The work is in its inbox; start it yourself with: ` +
            `${adapter.binary} ${(adapter.args || []).join(' ')} "<prompt>"`
        }
      }
      const path = resolve()
      if (!path) return { delivered: 'failed', detail: `${adapter.binary} is not installed` }
      const child = spawn(path, [...(adapter.args || []), prompt], { cwd, stdio: 'ignore', detached: true })
      child.unref()
      return { delivered: 'spawned', pid: child.pid }
    }
  }
}
