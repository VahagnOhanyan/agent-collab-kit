---
name: gemini-review
description: Run a pending collab review addressed to Gemini (Antigravity CLI, `agy`) as a custom agent that has NO shell and NO write tool — only file reading, search and four collab tools — and bring its verdict back to the owner. Use when the owner says "запусти Gemini на ревью", "gemini review", "/gemini-review", optionally with a review id or task id. Gemini never starts on its own.
---

# gemini-review — Gemini reviews without the right to write

The reviewer runs as the `agy` custom agent `readonly-reviewer` (installed by the kit into
`~/.gemini/config/agents/readonly-reviewer.md`). Its toolset is `view_file`, `grep_search`, `find_by_name`,
`list_dir` with `excludeDefaultComponents: true`: there is no `run_command` and no `write_to_file` to deny —
writing is impossible, not forbidden. The collab journal is narrowed in `~/.gemini/antigravity-cli/settings.json`
to `mcp(collab/whoami)`, `mcp(collab/get_messages)`, `mcp(collab/get_task)`, `mcp(collab/submit_review)`; any
other collab tool (a check run, a claim, a task change) is auto-denied and ends the headless run.

Proven by a probe on agy 1.3.0: read, search, list and `whoami` worked; "create a file" and "run a shell command"
had no tool; `list_runners` was refused; the tree fingerprint before and after was equal.

**macOS and Linux only**, like `claude-review`.

Argument: optional `rev_…` or `tsk_…`. Without one — every pending review addressed to `gemini`.

## 1. Find what is waiting

```bash
collab project --json      # journalRoot, codeRoot, initialized
collab inbox gemini        # review_request messages: task id, review id, round
collab task <task_id>      # files, branch, git_base, criteria, earlier rounds
```

Task `cancelled` / `completed` → the review is stale: report it, do not run. Nothing pending → say so and stop.

## 2. Prepare the evidence — the reviewer has no git

1. The tree under review (main checkout or the task's worktree; several candidates → ask the owner).
2. A private directory (a separate call — shell variables do not survive between calls):

   ```bash
   out_dir=$(mktemp -d "${TMPDIR:-/tmp}/gemini-review.XXXXXXXX") && chmod 700 "$out_dir" && echo "$out_dir"
   ```

3. Into it, the whole change:
   - committed work: `git -C <tree> show --stat --patch <commit>…` for each commit of the task
     → `<out_dir>/changes.patch` (or `git diff <git_base>..HEAD -- <files>` when the task has a base);
   - what moved since: `git -C <tree> log --oneline <first>^..HEAD -- <files>` → `<out_dir>/log.txt`;
   - uncommitted work: `git -C <tree> diff HEAD -- <files>` → `<out_dir>/uncommitted.patch`;
   - new files: `git -C <tree> ls-files --others --exclude-standard` → `<out_dir>/untracked.txt`.
4. The tree fingerprint before the run — the same command as in `claude-review`, step 2.4.

## 3. Run — one review per run, in the background

Model: the **L2 rung** for Gemini from `collab models` (never from memory).

```bash
cd "<tree>" && agy --sandbox --agent readonly-reviewer --add-dir "<out_dir>" \
  --model <slug> --print-timeout 0s -p "<prompt>" </dev/null > "<out_dir>/<rev_id>.txt" 2>&1
```

Prompt: who it is (`gemini`), the order `whoami` → `get_task` → review → `submit_review(<rev_id>)`, that it has no
shell and must not call other collab tools, where the evidence is (`<out_dir>/changes.patch`, `log.txt`), what to
check (criteria, findings of the previous round), and the output contract (severity, `file:line` of the CURRENT
file in the tree — not the patch line —, failure scenario, evidence; no evidence = hypothesis). `-p` takes the
prompt as its value — put it last.

- `run_in_background: true`; several reviews → one after another (one subscription quota).
- A run that ends with `no output produced — a tool required the "mcp" permission` called a collab tool outside
  the four: re-run with a stricter prompt; never widen the permissions.
- `RESOURCE_EXHAUSTED (429)` — the subscription quota: stop and tell the owner when it resets.

## 4. Check before relaying

1. The verdict in the journal (`collab task <task_id>`) is the truth, not the run's text.
2. Open the top finding's `file:line` yourself; say which findings you confirmed.
3. No verdict → show the tail of `<out_dir>/<rev_id>.txt`; never submit on its behalf.
4. The fingerprint after the run equals the one before.
5. Remove `<out_dir>`.

## 5. Report to the owner (in their language)

Verdict · findings with `file:line` · what you verified yourself · that the review ran without the right to write ·
what the task needs next. `changes_requested` is not a licence to start fixing.
