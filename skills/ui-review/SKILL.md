---
name: ui-review
description: Human-in-the-loop visual improvement of ONE iOS screen with Codex as the independent designer. Real simulator screenshot → Codex renders 3–5 variants → a fresh Codex session scores them → Claude's own critique → OWNER APPROVAL → implementation → before/after screenshots → functional check. Use when the owner says "Improve <screen>", "Run visual review for <screen>", "Generate N alternatives for <screen>", "/ui-review <screen>".
---

# ui-review — real app → AI variants → owner decides → implement → verify

**Roles.** Claude orchestrates: repo, simulator, context, its own critique, implementation, verification, talking to the owner. Codex is the independent designer and critic: it renders and evaluates variants, it never edits code here. The owner decides.

**Hard gate.** No edit to production UI until the owner explicitly approves a direction in chat. Silence, "ok looks nice", or a question is not approval.

Scripts: `tools/ui-review/` — `capture.sh` (deterministic screenshot), `codex.sh explore|evaluate` (Codex stages), `compare.sh` (side-by-side sheet).

## Run directory
`.ui-review/<screen-slug>/<YYYY-MM-DD>-<n>/` (gitignored):
`baseline-<state>.png` · `context.md` · `explore.json` + `variant-<ID>.png` · `evaluate.json` (+ `hybrid.png`) · `claude-critique.md` · `compare-variants.png` · `decision.md` · `after-<state>.png` · `compare-after.png`.

## 0. Scope
- Screen → root view files (`Tripix/CLAUDE.md`, `docs/design/patterns.md`). Trip creation lives in `Tripix/View/RouteContextMapOverlay/AddTrip/`, not `Features/`.
- Nobody else is editing it: `git status` / recent `git log` on its files, live collab claims (`.collab/tasks/*.json` → `files`). A live claim → tell the owner, stop.
- Read the screen's CONFIRMED decisions in `docs/design/design-decisions.md` §1 and the §6 list. `.claude/rules/design-system.md` still says v1 is PROPOSED and bans broad visual changes of existing screens — the owner's approval in step 5 is what authorises a change; say so in the approval summary.

## 1. Baseline — the real app
Build in the background (skip if the tree is unchanged since the last build):
```bash
DD=$(ls -d ~/Library/Developer/Xcode/DerivedData/Tripix-* | head -1)
xcodebuild -project /Users/vahagnohanyan/Tripix/Tripix.xcodeproj -scheme Tripix -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max,OS=26.1' -derivedDataPath "$DD" build
```
Capture. The app's own appearance setting (`Tripix/Utils/AppearanceManager.swift`) defaults to dark and ignores the simulator's system appearance unless it is set to System inside the app — `--appearance light` alone does not give a light screenshot:
```bash
tools/ui-review/capture.sh .ui-review/<slug>/<run>/baseline-default.png --install
```

| Screen / state | How to reach it |
|---|---|
| Feed (default tab) | plain launch |
| Trip Detail | `--env TRIPIX_DEBUG_OPEN_TRIP_ID=<id> [--env TRIPIX_DEBUG_OPEN_CONTEXT_ID=<ctx>] --wait-for 'apply startup route ready'` |
| Design-system catalog section | `--env TRIPIX_DEBUG_DESIGN_CATALOG=<section>` |
| Sheet / date-picker stands | `--env TRIPIX_DEBUG_SHEET_STAND=1\|large\|add`, `--env TRIPIX_DEBUG_DATE_PICKER_STAND=1` |
| Anything that needs taps, scrolling, a keyboard | ask the owner to navigate in Simulator, then `capture.sh … --no-launch` |

- Trip ids: `curl` `GET $AWEIRO_API_BASE_URL/trip` with `x-seed-token: $AWEIRO_SEED_TOKEN` and `x-as-user: <simulator user id>` (app prefs `mostRecentBackendUserId`). Use curl — Cloudflare rejects python-urllib with error 1010. Creating or deleting data needs the owner's OK.
- Capture the states that matter for the screen: default, scrolled / expanded, empty, loading, error, sheet open, keyboard.
- **Read every PNG** before it goes anywhere: right screen, right state, content loaded.
- Only the `iPhone 17 Pro Max` simulator holds the signed-in session (no login bypass) — never erase it. Do not pre-set a map camera to fake a shot.
- Re-takes are not pixel-identical (live dev backend, map tiles, relative dates): compare structure, not pixels.

## 2. Context for Codex → `context.md`
Gather with an `Explore` subagent to keep the main context light; every claim cites a file. Sections:
Screen & purpose · User goal · Surrounding screens & navigation · Every interaction (tap, long-press, double-tap, swipe, pull-to-refresh, menus, navigation targets) · States captured (file → state) · Relevant code (paths) · Tokens / components in use · Confirmed decisions that bind it (IDs) · **MUST PRESERVE** · **CAN CHANGE** · Problems the owner raised · Platform: iPhone, iOS 18+, SwiftUI, en + ru.

## 3. Codex explores — in the background
```bash
tools/ui-review/codex.sh explore .ui-review/<slug>/<run> 4     # run_in_background: true; owner's count wins (3–5)
```
Then check: `image_tool` is not `NONE`; every variant has `local_image`; **Read each image**. Missing renders → report which step failed. Claude cannot render images — never substitute its own drawings or HTML and call them mockups. Call out variants that dropped a MUST PRESERVE item or changed the data.

## 4. Two perspectives
1. `tools/ui-review/codex.sh evaluate .ui-review/<slug>/<run>` — a fresh Codex session: scores, one recommendation (hybrid allowed, rendered), risks.
2. Claude's independent critique → `claude-critique.md`: which variant is safest and most appropriate for THIS codebase — real files, tokens, components, `scripts/design-system-baseline.txt` ratchets, confirmed decisions, user flows, Dynamic Type / ru text, map and sheet behaviour. State agreement or disagreement with Codex's pick and why. Do not just agree; disagreement is useful.
3. `tools/ui-review/compare.sh .ui-review/<slug>/<run>/compare-variants.png Baseline=… A=… B=… [Hybrid=…]`, then `open` it for the owner.

## 5. Approval gate — STOP
Show the owner (in Russian): original screenshot · every variant (one line each) · compact score table · Codex's recommendation · Claude's position (agree / disagree and why) · the hybrid, if any · implementation impact (files, tokens/components, complexity, risks) · the design-system status note from step 0. Open the comparison sheet locally with `open`.

Ask for exactly one of: approve the recommendation · choose another variant · combine specific parts · another iteration (with what feedback) · reject all. Then stop. When the owner answers, write their answer verbatim with the date into `decision.md`.

## 6. Implement — only after explicit approval
- `.claude/rules/design-system.md` order: component → pattern → tokens. A missing value is a design decision (entry in `design-decisions.md`), not a literal. No one-off layouts, duplicated components, magic numbers, screenshot-specific hacks, broken native gestures, or edits to unrelated screens.
- An approved idea conflicts with a technical or UX constraint → stop that part, explain the conflict, ask. Never quietly change the approved design.
- `.claude/rules/workflow.md`: current branch unless the owner asks for one; `claim_files` in collab; commit only on request. Large edits can go to the `ios-implementer` subagent.

## 7. Visual verification
Rebuild, capture the same states with the same flags → `after-<state>.png`; `compare.sh … Baseline=… Target=… After=…`; Read it. List discrepancies — spacing, alignment, type, hierarchy, icon size, radii, clipping, safe areas, sheet behaviour, aspect ratios, bars — and fix the real ones. Mockups are approximate (text rendering, exact sizes): do not pixel-chase differences that come from correct native rendering. A second opinion is cheap: `codex exec -s read-only -C <repo> "<list discrepancies between target and after>" -i target.png -i after.png`.

## 8. Functional verification
Walk the screen's flow on the simulator where it is reachable; whatever needs taps — ask the owner and say it was checked by hand. `xcodebuild … build-for-testing`; affected test classes listed (full `TripixTests` is NOT run — say so); `scripts/check-design-system.sh`, `node scripts/check-design-tokens.mjs`, `scripts/preflight.sh`; independent check by the `verifier` subagent or the owner on device. Say plainly what was not verified.

## 9. Design memory
Only what the owner approved goes into `docs/design/design-decisions.md` §1 as the next `C-<n>`: date, what was chosen, why, and one line on the rejected directions and the reason. No separate document.
