---
name: ux-critic-review
description: Run the independent UX review of a user-facing change — the ux_reviewer collab role reads the diff and the screenshots it is given and returns blocker/major/minor/nit findings, never edits. Use when a task's spec has ux_impact HIGH (the completion gate requires it) or MEDIUM with needs_ux_critic true, or when the owner says "UX-ревью", "ux critic", "/ux-critic-review" with a task id.
---

# ux-critic-review — independent UX review, review only

The collab layer decides WHEN this is needed: a task whose `spec.ux_impact` is `HIGH`, or `MEDIUM` with `needs_ux_critic: true`, cannot be completed until the `ux_reviewer` role has approved it with no proven blocker/major (`complete_task` refuses with the reason). This skill is HOW the review is run. It never starts on its own.

**The reviewer never edits.** It reads, judges, submits findings. Fixes are made by whoever implemented the change, and verified the way that change is verified (simulator, device, tests) — the reviewer cannot run the app.

Argument: a `tsk_…` id. No journal (`collab project --json` → `initialized: false`) → tell the owner to run `collab init`; create nothing.

## 1. Read the task

`collab task <task_id>`: `spec.ux_impact`, `spec.ux_domains`, `spec.needs_visual_verification`, acceptance criteria, files. `ux_impact` NONE/LOW, or MEDIUM without `needs_ux_critic` → no independent review is required; say so and stop unless the owner asked for one anyway.

## 2. Prepare the evidence

- **Diff**: the tree and range the change lives in (same rule as `codex-review` step 2 — one matching tree or ask the owner).
- **Screenshots** — when `needs_visual_verification` is true or the change is visual: capture the affected states with the project's own screenshot procedure (in Tripix: the `ui-shot` skill; the device via `device-run` only with the owner's word). Name every PNG by state (`empty.png`, `loading.png`, `error.png`, `after-return.png`) — the reviewer sees pixels, not your intent. No screenshots possible → say so in the request; the reviewer then judges from the diff only and must mark visual claims as hypotheses.
- **Knowledge**: only the `ux-guidance` references matching `spec.ux_domains` (see that skill's table). Pass their absolute paths under `$HOME/.agent-kit/current/skills/ux-guidance/references/`, not their content.

## 3. Request the review in collab

`request_review(task_id, reviewer_role: "ux_reviewer", slot: "ui", blocking: false, instructions: <one paragraph: user goal, states captured, what changed>)`. Non-blocking on purpose: the code review keeps the one gating slot; the UX gate is enforced at completion instead. The answer names who holds the role (`routed_to`) — never pick the agent by name.

## 4. Run the reviewer — read-only, in the background

Today `ux_reviewer` is held by `codex`. A private output directory first (separate call, reuse the printed path):

```bash
out_dir=$(mktemp -d "${TMPDIR:-/tmp}/ux-review.XXXXXXXX") && chmod 700 "$out_dir" && echo "$out_dir"
```

```bash
codex exec --skip-git-repo-check -s read-only -m gpt-5.6-sol -C "<tree>" \
  -o "<out_dir>/<rev_id>.txt" \
  "You are the agent 'codex' acting as the ux_reviewer role. The 'collab' MCP tools are deferred — find them with tool search first, then whoami and get_messages with unread_only true. Your job is exactly one review: <rev_id> on task <task_id>. Read the task (get_task) and the request. Read the change in THIS tree (git diff against <base>) and the attached screenshots. Read these guidance files: <paths>. You CANNOT run the app — judge only what the diff and the screenshots show, and mark anything else as a hypothesis (no evidence field). Look for: a technically correct but confusing flow, poor discoverability of the entry point, unnecessary steps, missing feedback, bad loading/error/empty states, hidden state, broken leave-and-return, cancel/retry gaps, gesture conflicts, inaccessible interaction (labels, targets, Dynamic Type, reduced motion), layout that breaks on another size, behaviour inconsistent with the rest of the product. Do NOT redesign unrelated parts, do not question settled product decisions without a usability reason, and file subjective taste as nit. Severity: blocker = the user cannot finish the task, can lose data or trigger something dangerous by accident; major = confusing, hard to discover or clearly inconsistent; minor = works but worth improving; nit = polish. Every blocker/major needs evidence (screenshot name or file:line) and a concrete user scenario. Do not modify files. Finish with submit_review on <rev_id>: approved when nothing blocker/major is proven; changes_requested with findings otherwise." \
  -i "<screenshot1.png>" -i "<screenshot2.png>" \
  </dev/null
```

- Prompt BEFORE any `-i`. `run_in_background: true`, never `sleep`-poll. `</dev/null` always.
- `gpt-5.6-sol` is the L2 rung — enough for UX review; a stronger rung only with the cost named to the owner first. `collab models` is the ladder, not memory.
- If another agent holds the role, run that agent's own CLI with the same prompt; the protocol (read-only, `submit_review`) does not change.

## 5. Check, then relay

1. The verdict from `collab task <task_id>` — the journal is the truth, not the reviewer's chat output.
2. Look at the top blocker/major yourself against the screenshot or `file:line`. Say which you confirmed.
3. No verdict recorded → show the tail of the output file, say it failed, do not submit on the reviewer's behalf.
4. `rm -r "<out_dir>"` unless the owner wants the raw output.

## 6. After the verdict

- `changes_requested` with blocker/major → the implementer fixes, re-verifies the way the change is verified, then ONE new review round for the whole batch — not one round per finding.
- minor/nit → fix when cheap, otherwise leave them in the task's evidence as known limitations; they never block.
- A second round on the same mechanism with new blocker/major → stop and ask the owner whether the flow's shape is wrong, instead of patching again.

Report to the owner in Russian: verdict · findings with scenario and evidence · what you confirmed yourself · what remains.
