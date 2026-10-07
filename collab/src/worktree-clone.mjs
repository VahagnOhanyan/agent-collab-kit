// Ignored, heavy, machine-local directories a task's working copy needs to run
// its own checks — dependency trees such as `backend/node_modules`. `git
// worktree add` copies only what git tracks, so without them every test that
// imports a package fails inside the copy and the verifier cannot check the work
// where it was done.
//
// They are CLONED, not copied and not linked:
//   - a copy-on-write clone (APFS `clonefile`, `cp -c`) appears in seconds and
//     shares the original's blocks, so it costs almost no disk until a file in it
//     changes;
//   - unlike a symlink, the clone is the copy's own: installing a package inside
//     the copy cannot change the main tree's directory for everybody else.
// Where the file system cannot clone, nothing is copied: copying gigabytes per
// task would be a surprise, and the copy can still run `npm ci` itself. The
// result says which paths were cloned and why the others were not.

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function defaultRun(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr || (result.error ? String(result.error.message) : '') }
}

export function cloneIntoCopy({ codeRoot, copyDir, paths, platform = process.platform, run = defaultRun }) {
  const results = []
  for (const rel of paths) {
    const src = join(codeRoot, ...rel.split('/'))
    const dst = join(copyDir, ...rel.split('/'))
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      results.push({ path: rel, status: 'missing', detail: 'not in the main tree' })
      continue
    }
    if (existsSync(dst)) {
      results.push({ path: rel, status: 'exists', detail: 'already in the copy' })
      continue
    }
    if (platform !== 'darwin') {
      results.push({ path: rel, status: 'unsupported', detail: 'no copy-on-write clone on this platform; run the install inside the copy' })
      continue
    }
    if (!existsSync(join(dst, '..'))) {
      results.push({ path: rel, status: 'missing', detail: 'its parent directory is not in the copy' })
      continue
    }
    // -c: clonefile(2); fails instead of copying when the volume cannot clone.
    const out = run('/bin/cp', ['-cR', src, dst])
    if (out.status === 0) results.push({ path: rel, status: 'cloned', detail: 'copy-on-write clone' })
    else results.push({ path: rel, status: 'failed', detail: (out.stderr || `cp exited ${out.status}`).trim().slice(0, 200) })
  }
  return results
}
