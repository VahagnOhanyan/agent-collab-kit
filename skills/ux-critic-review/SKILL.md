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

- **Diff**: the tree and range the change lives in — exactly one tree touching the task's files, or ask the owner.
- **Screenshots** — when `needs_visual_verification` is true or the change is visual: capture the affected states with the project's own screenshot procedure (its screenshot/simulator skill; a physical device only with the owner's word). Name every PNG by state (`empty.png`, `loading.png`, `error.png`, `after-return.png`) — the reviewer sees pixels, not your intent. No screenshots possible → say so in the request; the reviewer then judges from the diff only and must mark visual claims as hypotheses.
- **Knowledge**: only the `ux-guidance` references matching `spec.ux_domains` (see that skill's table). Pass their absolute paths under `$HOME/.agent-collab-kit/current/skills/ux-guidance/references/`, not their content.

## 3. Request the review in collab

`request_review(task_id, reviewer_role: "ux_reviewer", slot: "ui", blocking: false, instructions: <one paragraph: user goal, states captured, what changed>)`. Non-blocking on purpose: the code review keeps the one gating slot; the UX gate is enforced at completion instead. The answer names who holds the role (`routed_to`) — never pick the agent by name.

## 4. Run the reviewer — read-only, in the background

`routed_to` names the agent holding `ux_reviewer`. Launch it with its vendor's adapter — the rule `rules/vendor-<id>.md` and that vendor's review skill say how (read-only mode, explicit model from `collab models` at L2 unless the owner agreed to pay for more, output into a private `mktemp -d` directory, screenshots attached as images, never `sleep`-poll). No adapter for that vendor on this machine → say so and stop; do not improvise a CLI.

The reviewer prompt is the same for every vendor — only `<agent-id>` changes:

```text
You are the agent '<agent-id>' acting as the ux_reviewer role. The 'collab' MCP tools are deferred — find them with tool search first, then whoami and get_messages with unread_only true. Your job is exactly one review: <rev_id> on task <task_id>. Read the task (get_task) and the request. Read the change in THIS tree (git diff against <base>) and the attached screenshots. Read these guidance files: <paths>. You CANNOT run the app — judge only what the diff and the screenshots show, and mark anything else as a hypothesis (no evidence field). Look for: a technically correct but confusing flow, poor discoverability of the entry point, unnecessary steps, missing feedback, bad loading/error/empty states, hidden state, broken leave-and-return, cancel/retry gaps, gesture conflicts, inaccessible interaction (labels, targets, Dynamic Type, reduced motion), layout that breaks on another size, behaviour inconsistent with the rest of the product. Do NOT redesign unrelated parts, do not question settled product decisions without a usability reason, and file subjective taste as nit. Severity: blocker = the user cannot finish the task, can lose data or trigger something dangerous by accident; major = confusing, hard to discover or clearly inconsistent; minor = works but worth improving; nit = polish. Every blocker/major needs evidence (screenshot name or file:line) and a concrete user scenario. Do not modify files. Finish with submit_review on <rev_id>: approved when nothing blocker/major is proven; changes_requested with findings otherwise.
```

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
