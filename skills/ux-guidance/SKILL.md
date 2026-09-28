---
name: ux-guidance
description: General UX judgement for user-facing changes on any platform — what to check before and after implementing so the result is not just technically correct but understandable, discoverable and recoverable. Load when a task's ux_impact is LOW or above (spec.ux_impact in collab, or the plan's "ux_impact:" line); read only the references its ux_domains name. Not a design system and not product rules — the project's own design system and decisions always win.
---

# ux-guidance — what to know when a change touches the user

The orchestration layer decides WHEN UX work is needed (`ux_impact`, `ux_domains`, `needs_ux_critic`, `needs_visual_verification` in the plan and the task spec). This skill is only WHAT to know. It never adds steps on its own.

## By level

| ux_impact | What to do here |
|---|---|
| NONE | Nothing. You should not have loaded this. |
| LOW | The five-line check below. No references, no report. |
| MEDIUM | The questions below for the categories this change touches, plus the references for its `ux_domains`. A few lines in the plan, not a document. |
| HIGH | Same, more thoroughly, before the first edit. After implementation an independent `ux_reviewer` review is required (skill `ux-critic-review`). |

**LOW check** — spacing, icon, typography, copy:
1. Same meaning as before? (an icon swap that changes what the action reads as is not LOW)
2. Still fits — long text, larger text size, the narrowest supported width?
3. Tap/click target not smaller than before?
4. Contrast and dark appearance still hold?
5. Consistent with the same element elsewhere in the product?

## Before implementing (MEDIUM/HIGH) — only the categories that apply

- **Goal** — what is the user trying to get done, in one sentence?
- **Entry point** — where do they start, and would they find it without being told?
- **Happy path** — how many steps; is any of them removable?
- **Feedback** — what tells them it worked, is working, or failed?
- **States** — empty, loading, partial, error, offline, no permission: which exist, what does each show?
- **Leaving and returning** — backgrounding, navigation away, relaunch: what is kept, what is lost?
- **Cancel / undo / retry** — can they back out; is a failure recoverable without starting over?
- **Consistency** — does the same thing behave the same way elsewhere in the product?

Write the answers that matter as acceptance criteria. Skip categories the change does not touch.

## References — load only what `ux_domains` names

| ux_domains | Reference |
|---|---|
| interaction, adaptive-layout | the platform reference (`references/ios.md` today) |
| async-feedback | `references/async-operations.md` |
| destructive-action | `references/destructive-actions.md` |
| navigation | `references/navigation.md` |
| maps | `references/maps.md` |
| media | `references/media.md` |
| accessibility | `references/accessibility.md` |

Platform facts (exact target sizes, system component behaviour, accessibility APIs) come from the platform skills already installed, not from here: for iOS `hig`, `ios-accessibility`, `swiftui-expert-skill`, `swiftui-iphone-duo`. A web or Android reference is added next to `ios.md` when a project needs it.

## Severity — the same scale the reviewer uses

- **blocker** — the user cannot reliably finish the task, can lose data, or can trigger something dangerous by accident. Must be fixed.
- **major** — confusing, hard to discover, needlessly difficult, or clearly inconsistent. Fixed before completion as a rule.
- **minor** — works, could be better. Fix when worthwhile.
- **nit** — polish. Never blocks.

## Guard against bureaucracy

- Respect settled product decisions and the design system; propose a change to them only with a usability reason, and outside this task.
- Do not redesign parts the change did not touch.
- A matter of taste is a nit, not a major.
- No UX report for LOW. For MEDIUM, a few lines in the plan are enough.
- One review round per batch of findings, never one round per finding.
