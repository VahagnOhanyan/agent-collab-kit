// Read and write a JSON record so a concurrent reader never sees half of one.
//
// Writes go to a staging file and are moved into place with rename(2), which is
// atomic within a filesystem: a reader opens either the old inode or the new
// one. That property is what lets every read path in this layer run WITHOUT
// taking the lock, which in turn is why `collab status` still answers when a
// writer is wedged — the moment observation needs the mutex, the tool you reach
// for when things are stuck is the tool that hangs.
//
// There is deliberately no fsync before the rename. fsync buys durability
// against power loss, not against a process crash (the page cache survives
// that), and costs milliseconds on every write. For a local coordination file
// whose worst case is "re-read the audit log", that trade is not worth paying
// on every single update.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    // A truncated or corrupt record is not a missing record. Say which file, or
    // the next person debugs the whole directory.
    throw new Error(`collab: ${file} is not readable JSON: ${error.message}`)
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

export function writeJsonAtomic(file, value, { tmpDir } = {}) {
  const staging = tmpDir || join(dirname(file), '.tmp')
  if (!existsSync(staging)) mkdirSync(staging, { recursive: true })
  const temp = join(staging, `${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temp, file)
      return value
    } catch (error) {
      // POSIX rename(2) atomically replaces an existing destination no matter
      // what — every record update here overwrites the previous version.
      // Windows' MoveFileEx equivalent can transiently fail with EPERM/EBUSY/
      // EACCES if something else (an AV scanner, an editor's file watch, a
      // reader mid-open) holds `file` without FILE_SHARE_DELETE for a moment —
      // a window that does not exist on POSIX. A short retry absorbs it; on
      // POSIX this loop always succeeds on the first attempt, so it costs
      // nothing there.
      if (attempt < RENAME_ATTEMPTS && RETRYABLE_RENAME.has(error.code)) {
        sleepSync(10 * attempt)
        continue
      }
      try {
        unlinkSync(temp)
      } catch {
        // The rename is the failure worth reporting; a leftover staging file is not.
      }
      throw error
    }
  }
}
