---
name: claude-review
description: Run a pending collab review addressed to Claude in a separate Claude session that CANNOT write — no edit tools, no shell, only the collab journal — and bring its verdict back to the owner. Use when the owner says "запусти Claude на ревью", "claude review", "/claude-review", optionally with a review id or task id, or when a review routed to `claude` (code_reviewer, ux_reviewer, security_reviewer) must be done. Never review in an open Claude session: it has the right to edit.
---

# claude-review — Claude reviews without the right to write

A role is a routing label. `request_review(role: "code_reviewer")` routed to `claude` only drops a message into
Claude's inbox; it does not stop the session that picks it up from editing. An open Claude session normally has edit
and shell tools, so a review done there is a review by an agent that could change what it reviews. This skill runs the
review as a **separate** `claude -p` whose session has no edit or shell tool at all and sees only the `collab` journal.
The launch is the catalog's `adapter.review_launch` for `claude` (`collab/config/agents.json`), proven by a probe on
2026-10-02 (Claude Code 2.1.287) in a tree whose project settings carried hooks that write files: neither the model
nor the hooks could write; without `--setting-sources ""` the hooks did.

Any lead runs this — Claude or another vendor's agent — through its shell. Nothing starts it on its own.

**macOS and Linux only.** The steps use a POSIX shell (`mktemp`, `chmod`, `printf`, redirection). On Windows the
facts take the reviewer roles away from Claude (the launch lists `platforms: darwin, linux`) — there is no proven
read-only launch there yet, so do not improvise one.

**What this does not prove.** The journal records which agent answers a review, not how its session was launched. An
open Claude session with edit rights, under the same id, could still answer. The guarantee is: reviewer roles go only
to agents with a proven launch, and a review is run through this skill — never answered in an open session.

No journal for this project (`collab project --json` shows `initialized: false`) — tell the owner to run `collab init`
in the project root. Do not create anything yourself.

Argument: optional `rev_…` or `tsk_…`. Without one — every pending review addressed to `claude`.

## 1. Find what is waiting

```bash
collab project --json      # journalRoot, codeRoot, initialized
collab inbox claude        # review_request messages: task id, review id, round, requested role
collab task <task_id>      # the task: files, branch, criteria, earlier rounds
```

Task `cancelled` / `completed` → the review is stale: report it, do not run. Nothing pending → say so and stop.

## 2. Pick the tree and prepare the evidence

The reviewer has **no shell**, so it cannot run `git diff` itself. The lead prepares what it reads:

1. The tree under review (main checkout or the task's worktree — as in `codex-review`, step 2; several candidates →
   ask the owner).
2. A private directory (a separate call — shell variables do not survive between calls):

   ```bash
   out_dir=$(mktemp -d "${TMPDIR:-/tmp}/claude-review.XXXXXXXX") && chmod 700 "$out_dir" && echo "$out_dir"
   ```

3. Into it, everything the change is — the reviewer cannot run git to find what is missing:
   - committed on the branch: `git -C <tree> diff origin/main...HEAD > <out_dir>/diff.patch`;
   - staged: `git -C <tree> diff --cached >> <out_dir>/diff.patch`;
   - unstaged: `git -C <tree> diff >> <out_dir>/diff.patch`;
   - new files: `git -C <tree> ls-files --others --exclude-standard > <out_dir>/untracked.txt` — the reviewer reads
     each listed file in the tree itself;
   - for a UX review, the screenshots `ux-critic-review` prepared.
4. The fingerprint of the tree BEFORE the run, to prove afterwards that the review wrote nothing:
   `(git -C <tree> diff HEAD; git -C <tree> ls-files --others --exclude-standard | xargs -I{} shasum "<tree>/{}") | shasum > <out_dir>/before.sha`
5. A journal-only MCP config — the review session sees `collab` and nothing else (no browser, no other servers):

   ```bash
   printf '{"mcpServers":{"collab":{"command":"%s","args":["%s"],"env":{"COLLAB_AGENT_ID":"claude"}}}}\n' \
     "$(command -v node)" "$HOME/.agent-collab-kit/current/collab/src/mcp/server.mjs" > "<out_dir>/mcp.json"
   ```

## 3. Run the review — one per run, in the background

Model: the **L2 rung** for Claude from `collab models` — never from memory. When the author of the task is Claude
too, the review is same-vendor: `request_review` already required a reviewer model that is not the author's and not
weaker — use exactly that one.

```bash
cd "<tree>" && claude -p "<prompt>" \
  --model <reviewer model> \
  --setting-sources "" \
  --tools "Read,Grep,Glob" \
  --allowedTools "mcp__collab__whoami,mcp__collab__get_messages,mcp__collab__get_task,mcp__collab__submit_review" \
  --permission-mode manual --permission-prompts none \
  --strict-mcp-config --mcp-config "<out_dir>/mcp.json" \
  --add-dir "<out_dir>" \
  --output-format text </dev/null > "<out_dir>/<rev_id>.txt" 2>&1
```

Prompt: "You are the agent 'claude', reviewing in a session that cannot write. Call whoami and get_messages
(unread_only true). Your job is exactly one review: <rev_id> on task <task_id>. Read the task with get_task. The
change is in <out_dir>/diff.patch; read the files it touches in this tree for context. Scope: the task's files. Audit
the mechanism, not only the diff: list everything you find with severity and file:line and a failure scenario. Do
not claim anything verified beyond what you read. Finish with submit_review on <rev_id>." For `ux_reviewer` — the
reviewer prompt of `ux-critic-review`, step 4, with the screenshot paths in `<out_dir>`.

What each flag holds — none of them is optional:

| Flag | Holds |
|---|---|
| `--setting-sources ""` | No user, project or local settings: their hooks do not run (a project hook that writes a file was proven to run without this flag) |
| `--tools "Read,Grep,Glob"` | The session's built-in tools are these three: no Edit, Write, NotebookEdit, no Bash. Writing is impossible, not forbidden |
| `--strict-mcp-config --mcp-config` | Only `collab`; servers from the owner's settings (a browser, an app's API) are not loaded |
| `--allowedTools` four journal tools + `--permission-prompts none` | Only what a review needs runs without a prompt; everything else — `start_run` (it runs commands in the tree), `claim_files`, any task change — is refused automatically, nobody is there to answer |
| `--add-dir "<out_dir>"` | The evidence directory is readable |

- `run_in_background: true` — a review takes minutes. Never `sleep`-poll.
- Several pending reviews → one after another, not in parallel.
- Do not "fix" a failed run by adding a tool. A reviewer that needs a shell is a different launch, and it is not
  read-only.

## 4. Check before relaying

1. The verdict in the journal (`collab task <task_id>`) is the truth, not the session's text.
2. Open the top finding's `file:line` yourself; say which findings you confirmed and which you did not check.
3. No verdict submitted → show the tail of `<out_dir>/<rev_id>.txt`, say it failed; never submit on its behalf.
4. The same fingerprint as step 2.4, taken again after the run, equals `before.sha` — the evidence that the review
   wrote nothing. `git status --porcelain` is not: a file already marked modified can change again and keep its mark.
5. Remove `<out_dir>` unless the owner wants the raw output kept.

## 5. Report to the owner (in their language)

Verdict · findings with `file:line` and failure scenario · what you verified yourself · that the review ran without
the right to write · what the task needs next. `changes_requested` is not a licence to start fixing — fixing is a
separate request from the owner.
