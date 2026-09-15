---
name: codex-review
description: Hand pending collab reviews to Codex (the independent code_reviewer) and bring its verdict back to the owner. Use when the owner says "запусти Codex на ревью", "codex review", "/codex-review", optionally with a review id or task id. Codex never starts on its own — autostart is off by default in the collab config (adapter.enabled: false), this skill is the manual trigger.
---

# codex-review — manual trigger for Codex reviews

`request_review(role: "code_reviewer")` only drops a `review_request` message into Codex's collab inbox. Nothing launches Codex on its own. This skill is how the lead session runs it on the owner's explicit request.

No journal for this project (`collab project --json` shows `initialized: false`, or `.collab/` is simply missing) — tell the owner to run `collab init` in the project root. Do not create anything yourself.

Argument: optional `rev_…` or `tsk_…`. Without one — every pending review addressed to `codex`.

## 0. Find the project

`collab project --json` in the current directory reports `journalRoot`, `codeRoot`, `initialized`, `projectId`, `registryDir`. If `initialized` is false, stop here (see above).

## 1. Find what is waiting

The CLI has no `--reviewer` flag on `collab reviews` — the underlying store can filter by reviewer, but the command as wired only takes `--pending`. So cross-reference two commands instead of reading `.collab/` files directly:

```bash
collab inbox codex        # review_request messages addressed to codex: task id, review id, round
collab task <task_id>     # that task's reviews section: round, reviewer, verdict, findings
```

`collab reviews --pending` lists every pending review in the project (each line shows `author -> reviewer`) — useful as a cross-check when you want the whole picture rather than one agent's inbox.

- Task `cancelled` / `completed` → the review is stale. Report it, do not run Codex on it.
- Nothing pending → say so and stop. Do not invent work.

## 2. Pick the tree Codex reads

The code under review is often in a worktree, not in the project's main checkout.
- `collab task <id>` shows the task's branch, if any → find its path with `git worktree list --porcelain`.
- No branch → the worktree whose `git diff --name-only origin/main...HEAD` plus `git status --porcelain` touches the task's `files`. Exactly one match → use it. None or several → ask the owner, do not guess.

## 3. Run Codex — one review per run, in the background

First make a private output directory (a separate Bash call — shell variables do not survive between calls, so reuse the printed path literally below):

```bash
out_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-review.XXXXXXXX") && chmod 700 "$out_dir" && echo "$out_dir"
```

Never write to a predictable fixed name in the shared `/tmp` (for example one built from the review id): another local process can pre-create it or plant a symlink there and get Codex's output redirected or overwritten. Inside a fresh `0700` directory owned by the owner nobody else can do that.

```bash
codex exec --skip-git-repo-check -s read-only -m gpt-5.6-sol -C "<tree>" \
  -o "<out_dir>/<rev_id>.txt" \
  "You are the agent 'codex'. The 'collab' MCP tools are deferred — find them with tool search first, then call whoami and get_messages with unread_only true. Your job is exactly one review: <rev_id> on task <task_id>. Read the task with get_task and the review request, then review the code in THIS tree against origin/main (git diff, git log). Scope: the files on the task. Do not modify files, do not commit, do not touch other tasks or reviews, and do not claim anything is fixed or verified beyond what you actually read. Finish with submit_review on <rev_id>: approved only if correct; changes_requested with concrete findings (file:line, failure scenario) otherwise." \
  </dev/null
```

- `run_in_background: true` — a review takes minutes. Never `sleep`-poll.
- `-s read-only`: Codex reads code and runs read-only commands; `submit_review` still works because the MCP server runs outside the sandbox.
- `gpt-5.6-sol` is the **L2 rung** for this vendor and the default for a review — most reviews belong there. Do not name a model from memory: `collab models` is the ladder, and `collab doctor` says whether the ids in it are still true. Dropping to L1 (`terra`) is fine for a small local diff on your own judgement; the L3 rung (`astra`) needs the cost named to the owner and a yes first — never swap it in silently.
- Several pending reviews → run them one after another, not in parallel (each spends the plan's Codex allowance).
- `-i` takes several values: always put the prompt BEFORE any `-i`.
- The review run keeps the `collab` MCP server ON: Codex needs it for `whoami`, `get_messages`, `get_task` and `submit_review` — without it the verdict never reaches the journal. Any other Codex run from this skill that does not need collab (an ad-hoc question, a dry run of the prompt) gets `-c mcp_servers.collab.enabled=false`, so it cannot read or write the journal as `codex`.

## 4. Check before relaying

1. Read the verdict via the CLI (`collab task <task_id>`, or `collab reviews --pending`) — the collab record is the truth, not Codex's chat reply and not `.collab/` files read directly.
2. Verify at least the top finding against the code yourself (open the cited `file:line`). Say which findings you confirmed and which you did not check.
3. If Codex did not submit (no verdict change) — show the tail of its output file (`<out_dir>/<rev_id>.txt`) and say it failed; do not submit on its behalf.
4. When done, remove the directory (`rm -r "<out_dir>"`) unless the owner wants the raw output kept.

## 5. Report to the owner (in Russian)

Verdict · findings with `file:line` and failure scenario · what you verified yourself · what the task needs next. `changes_requested` on Claude's own task is NOT a licence to start fixing — fixing is a separate request from the owner.
