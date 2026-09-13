// A real child process that increments a shared counter under the lock.
//
// The claim under test is about OS PROCESSES, so the test has to spawn them.
// Doing this with promises in one process would prove only that the in-process
// queue works, which is the half that was never in doubt.
//
// argv: <lockPath> <counterFile> <iterations> [holdMs]

import { readFileSync, writeFileSync } from 'node:fs'
import { withLock } from '../../src/lock.mjs'

const [lockPath, counterFile, iterationsRaw, holdRaw] = process.argv.slice(2)
const iterations = Number(iterationsRaw)
const holdMs = Number(holdRaw || 0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < iterations; i += 1) {
  await withLock(
    lockPath,
    async () => {
      // Read-modify-write with a deliberate gap: without a mutex this loses
      // updates almost every time, which is what makes the assertion meaningful.
      const current = Number(readFileSync(counterFile, 'utf8').trim())
      if (holdMs) await sleep(holdMs)
      writeFileSync(counterFile, String(current + 1))
    },
    { timeoutMs: 30_000, agentId: `worker-${process.pid}` }
  )
}

process.exit(0)
