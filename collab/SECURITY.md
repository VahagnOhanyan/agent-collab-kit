# collab — security notes

## Threat model, honestly

Every agent (Claude Code, Codex, …) runs as the same OS user as the owner, with a
shell. The journal is plain files in `.collab/`. Any agent, or code from a
malicious repository that an agent runs, can edit those JSON files directly —
including forging an approval. **This layer is not a security boundary.** It
removes the ordinary paths to a mistake and leaves an audit trail. Real
enforcement for dangerous actions belongs in the harness (permission rules and
PreToolUse hooks), outside the agents' reach.

## What the layer does guarantee

- **No MCP tool grants an approval.** Agents can ask (`request_user_approval`)
  and read; `test/mcp.test.mjs` and `collab check-config` check the tool list.
- **Owner decisions need the owner's terminal.** `collab approve|reject` and
  `collab init --adopt` refuse when `COLLAB_AGENT_ID` is set (every agent shell)
  or without an interactive TTY, and require the approval id / journal root typed back.
- **Every path into `in_progress` passes one gate** (`src/domain/gate.mjs`): a
  legal edge, the caller may hold the task (owner, unowned, or lapsed lease), the
  caller holds the task's role, and the policy. The state machine refuses the move
  without the gate's admission. A non-owner cannot re-status, release or reassign
  a task somebody else holds; only the owner or a contributor may request its
  review or complete it. Assigning an unowned task and `request_user_approval`
  (anyone may ask; only the owner grants) stay open to any agent.
- **Grants are single-use**, bound to the action's fingerprint, and consumed in
  the same transaction that starts the work.
- **Config and runners come only from the trusted registry** outside the
  repository (`projects/<id>/`), matched by journal root. A project policy can
  only make classification stricter, except rules explicitly marked
  `lowers_default` with a justification, which `collab check-config` lists.
- **The environment is not an input.** `COLLAB_CONFIG_DIR`, `COLLAB_REGISTRY_DIR`,
  `COLLAB_PROJECT_ROOT`, `COLLAB_STATE_DIR` are ignored (and reported). git is
  chosen by a working `--version` probe over fixed absolute paths and run with
  `GIT_*`, `NODE_OPTIONS`, loader and Apple toolchain variables (`DEVELOPER_DIR`,
  `SDKROOT`, `TOOLCHAINS`, `XCRUN_*`, `XCODE*`) stripped. Runners get the same
  environment, find bare commands only on a fixed PATH, and must keep cwd and
  path arguments inside the working tree by realpath.
- **No implicit journal.** Only `collab init` creates `.collab/`. Refused: symlinked,
  empty or half-built journals; git-tracked ones (and any journal git cannot
  answer for — only a definitive "not a git repository" skips the check); a marker
  bound to a different root (copied or moved). A markerless legacy journal is
  accepted only at a root whose registry project sets `"legacy_journal": true`.

## Residual risks, not fixed, and why

- **Runner path TOCTOU.** Paths are checked, then the process is spawned; a
  symlink swapped in between is followed. Node offers no openat-style spawn.
- **Commits are not crash-atomic across files.** A transaction writes records one
  rename at a time. It fails closed: a crash can leave a grant consumed without the
  task having started, never the reverse — ask the owner again.
- **Forgery by a same-user process**, marker included (see the threat model).
- **A fixed PATH is not a trust anchor.** It includes user-writable directories
  (node's Homebrew Cellar dir, `/opt/homebrew/bin`); a same-user process can place
  a binary there.
- **`legacy_journal: true` trusts whatever markerless journal sits at that root**,
  including one copied there. `collab init --adopt` binds it and removes the need.
- **Approving a project's `.mcp.json` means trusting that repository to run code**
  on this machine. Nothing here can make that safe.
