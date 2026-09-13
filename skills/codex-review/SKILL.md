---
name: codex-review
description: Hand pending collab reviews to Codex (the independent code_reviewer) and bring its verdict back to the owner. Use when the owner says "запусти Codex на ревью", "codex review", "/codex-review", optionally with a review id or task id. Codex never starts on its own — autostart is off by owner decision 2026-09-10, this skill is the manual trigger.
---

# codex-review — manual trigger for Codex reviews

`request_review(role: "code_reviewer")` only drops a message into Codex's collab inbox. Nothing launches Codex (`tools/collab/config/agents.json` → `adapter.enabled: false`). This skill is how the lead session runs it on the owner's request.

Argument: optional `rev_…` or `tsk_…`. Without one — every pending review addressed to `codex`.

## 1. Find what is waiting

```bash
cd /Users/vahagnohanyan/Tripix && python3 - <<'EOF'
import json, glob
tasks = {t['id']: t for t in (json.load(open(f)) for f in glob.glob('.collab/tasks/*.json'))}
for f in sorted(glob.glob('.collab/reviews/*.json')):
    r = json.load(open(f))
    if r.get('reviewer') != 'codex' or r.get('verdict') != 'pending':
        continue
    t = tasks.get(r['task_id'], {})
    print(r['id'], 'round', r['round'], '|', t.get('status'), '|', t.get('title'), '| branch:', t.get('branch'))
EOF
```

- Task `cancelled` / `completed` → the review is stale. Report it, do not run Codex on it.
- Nothing pending → say so and stop. Do not invent work.

## 2. Pick the tree Codex reads

The code under review is often in a worktree, not in `~/Tripix`.
- `task.branch` set → its path from `git worktree list --porcelain`.
- `branch` null → the worktree whose `git diff --name-only origin/main...HEAD` plus `git status --porcelain` touches the task's `files`. Exactly one match → use it. None or several → ask the owner, do not guess.

## 3. Run Codex — one review per run, in the background

```bash
codex exec --skip-git-repo-check -s read-only -C "<tree>" \
  -o /tmp/codex-review-<rev_id>.txt \
  "You are the agent 'codex'. Use the 'collab' MCP tools — they are deferred, find them with tool search first. Call whoami, then get_messages with unread_only true. Your job is exactly one review: <rev_id> on task <task_id>. Read the task with get_task and the review request, then review the code in THIS tree against origin/main (git diff, git log). Scope: the files on the task. Do not modify files, do not commit, do not touch other tasks or reviews. Finish with submit_review on <rev_id>: approved only if correct; changes_requested with concrete findings (file:line, failure scenario) otherwise. Then reply with the verdict and a short summary." \
  </dev/null
```

- `run_in_background: true` — a review takes minutes. Never `sleep`-poll.
- `-s read-only`: Codex reads code and runs read-only commands; `submit_review` still works because the MCP server runs outside the sandbox.
- Model and effort come from `~/.codex/config.toml`. Several pending reviews → run them one after another, not in parallel (each spends the ChatGPT plan's Codex allowance).
- `-i` takes several values: always put the prompt BEFORE any `-i`.

## 4. Check before relaying

1. Read `.collab/reviews/<rev_id>.json` — `verdict`, `summary`, `findings`. The collab record is the truth, not Codex's chat reply.
2. Verify at least the top finding against the code yourself (open the cited `file:line`). Say which findings you confirmed and which you did not check.
3. If Codex did not submit (no verdict change) — show the tail of its output and say it failed; do not submit on its behalf.

## 5. Report to the owner (in Russian)

Verdict · findings with `file:line` and failure scenario · what you verified · what the task needs next. `changes_requested` on Claude's own task is NOT a licence to start fixing — fixing is a separate request from the owner.
