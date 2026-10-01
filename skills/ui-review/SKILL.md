---
name: ui-review
description: Human-in-the-loop visual improvement of ONE screen with Codex as the independent designer. Real screenshot → Codex renders 3–5 variants → a fresh Codex session scores them → Claude's own critique → OWNER APPROVAL → implementation → before/after screenshots → functional check. Use when the owner says "Improve <screen>", "Run visual review for <screen>", "Generate N alternatives for <screen>", "/ui-review <screen>".
---

# ui-review — real app → AI variants → owner decides → implement → verify

**Roles.** Claude orchestrates: repo, device/simulator, context, its own critique, implementation, verification, talking to the owner. Codex is the independent designer and critic: it renders and evaluates variants, it never edits code here. The owner decides.

**Hard gate.** No edit to production UI until the owner explicitly approves a direction in chat. Silence, "ok looks nice", or a question is not approval.

Scripts: `$HOME/.agent-collab-kit/current/ui-review/` — `capture.sh` (deterministic screenshot, iOS Simulator only), `codex.sh explore|evaluate` (Codex stages, any platform), `compare.sh` (side-by-side sheet). All project parameters come from the trusted registry, never from the repo — see Project config below.

## Project config

Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`. Project data then lives at `<registryDir>/<projectId>/`:
- `ui-review.json` — `{ platform, project, scheme, bundleId, product, device, appearanceNote? }`. `capture.sh` reads this itself; you don't need to parse it by hand except to explain it to the owner.
- `ui-review.md` — everything project-specific this skill needs: how to reach screen states (launch flags/env), where the design system and confirmed-decisions docs live, where the design-decisions log is, project quirks (e.g. an in-app appearance setting that ignores the OS/simulator appearance), how to fetch any IDs needed to reach a state, copy rules, anything else worth knowing before touching this project's UI. Read it fully before step 0.

**No project in the registry, or no `ui-review.json`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself:
- schemes: `xcodebuild -list -json` in the repo (or a workspace, if one exists);
- bundle id: `PRODUCT_BUNDLE_IDENTIFIER` from the `.xcodeproj/project.pbxproj`;
- product name: the target/scheme name (verify against the built product name if a build exists);
- device: ask the owner, or default to a reasonable current simulator and ask them to confirm.
Show the drafted JSON in chat and ask for confirmation ("да"). Agents cannot write the registry — `~/agent-collab-kit` (and `~/.agent-collab-kit`) is hard-denied by the scope-guard hook regardless of any project's `scopes.json` — so after confirmation, ask the owner (or hand them the exact JSON and path) to add `<registryDir>/<projectId>/ui-review.json` themselves. Do the same for `ui-review.md` if useful project knowledge surfaces during the run and there's nowhere else to put it; otherwise record it in the run's `decision.md` (see step 9).

**Platform other than `ios-simulator`, or no `ui-review.json` at all.** The owner supplies screenshots by hand (baseline in step 1, after-screenshots in step 7); every other step of this workflow is unchanged — `codex.sh` and `compare.sh` don't care how an image was produced.

**Cost.** The rendering stages (`codex.sh explore` and `codex.sh evaluate`) default to `UI_REVIEW_MODEL=gpt-6-astra` because rendering needs it — this is a paid, non-default model. One explore + evaluate run on it costs roughly half of a ChatGPT Plus 5-hour usage window. State this plainly to the owner and wait for their consent before running either stage; do not run them "to save a round trip."

## Run directory
`.ui-review/<screen-slug>/<YYYY-MM-DD>-<n>/` (gitignored):
`baseline-<state>.png` · `context.md` · `explore.json` + `variant-<ID>.png` · `evaluate.json` (+ `hybrid.png`) · `claude-critique.md` · `compare-variants.png` · `decision.md` · `after-<state>.png` · `compare-after.png`.

## 0. Scope
- Screen → root view files. `ui-review.md` points at where these files and any screen-ownership docs live.
- Nobody else is editing it: `git status` / recent `git log` on its files, live collab claims (`collab inbox` / task files for this project) → a live claim means tell the owner and stop.
- Read the screen's confirmed design decisions — `ui-review.md` says where that log is (and whether the design system itself is still provisional / restricted). If a rule there requires explicit approval before any visual change to existing screens, say so up front and treat step 5 as satisfying it.

## 1. Baseline — the real app
**`ios-simulator` platform:**
Build in the background if needed (skip if the tree is unchanged since the last build) using the project/scheme/device from `ui-review.json`. Then capture:
```bash
$HOME/.agent-collab-kit/current/ui-review/capture.sh .ui-review/<slug>/<run>/baseline-default.png --install
```
Check `ui-review.json`'s `appearanceNote` and `ui-review.md` for anything like an in-app appearance setting that ignores the simulator's system appearance — `--appearance light` alone may not be enough.

Reaching non-default states (a specific trip/item id, a debug flag, a design-system catalog section, a sheet or picker stand, anything needing taps/scrolling/keyboard) is project-specific — the state table and how to fetch any ids it needs (e.g. a authenticated API call) live in `ui-review.md`. For anything requiring manual interaction, ask the owner to navigate in the simulator, then `capture.sh … --no-launch`.

**Any other platform, or no `ui-review.json`:** ask the owner for the screenshots for each state that matters; proceed with them exactly as with captured ones below.

- Capture/collect the states that matter for the screen: default, scrolled/expanded, empty, loading, error, sheet/modal open, keyboard.
- **Read every image** before it goes anywhere: right screen, right state, content loaded.
- If `ui-review.md` notes a device/simulator that holds the owner's only signed-in session (no login bypass) — never erase it.
- Re-takes are not pixel-identical when the app talks to a live backend or shows relative/dynamic content: compare structure, not pixels.

## 2. Context for Codex → `context.md`
Gather with an `Explore` subagent to keep the main context light; every claim cites a file. Sections:
Screen & purpose · User goal · Surrounding screens & navigation · Every interaction (tap, long-press, double-tap, swipe, pull-to-refresh, menus, navigation targets) · States captured (file → state) · Relevant code (paths) · Tokens/components in use · Confirmed decisions that bind it (IDs, from `ui-review.md`) · **MUST PRESERVE** · **CAN CHANGE** · Problems the owner raised · Platform and locales (from `ui-review.md`).

## 3. Codex explores — in the background
```bash
$HOME/.agent-collab-kit/current/ui-review/codex.sh explore .ui-review/<slug>/<run> 4     # run_in_background: true; owner's count wins (3–5)
```
Then check: `image_tool` is not `NONE`; every variant has `local_image`; **Read each image**. Missing renders → report which step failed. Claude cannot render images — never substitute its own drawings or HTML and call them mockups. Call out variants that dropped a MUST PRESERVE item or changed the data.

## 4. Two perspectives
1. `$HOME/.agent-collab-kit/current/ui-review/codex.sh evaluate .ui-review/<slug>/<run>` — a fresh Codex session: scores, one recommendation (hybrid allowed, rendered), risks.
2. Claude's independent critique → `claude-critique.md`: which variant is safest and most appropriate for THIS codebase — real files, tokens, components, any design-system ratchets `ui-review.md` names, confirmed decisions, user flows, text-scaling/locale behaviour, and any platform-specific behaviour (e.g. maps, sheets). State agreement or disagreement with Codex's pick and why. Do not just agree; disagreement is useful.
3. `$HOME/.agent-collab-kit/current/ui-review/compare.sh .ui-review/<slug>/<run>/compare-variants.png Baseline=… A=… B=… [Hybrid=…]`, then `open` it for the owner.

## 5. Approval gate — STOP
Show the owner (in Russian): original screenshot · every variant (one line each) · compact score table · Codex's recommendation · Claude's position (agree/disagree and why) · the hybrid, if any · implementation impact (files, tokens/components, complexity, risks) · any design-system status note from step 0. Open the comparison sheet locally with `open`.

Ask for exactly one of: approve the recommendation · choose another variant · combine specific parts · another iteration (with what feedback) · reject all. Then stop. When the owner answers, write their answer verbatim with the date into `decision.md`.

## 6. Implement — only after explicit approval
- Follow this project's own design-system order (component → pattern → tokens, or whatever `ui-review.md` / the project's own rules say). A missing value is a design decision (an entry in the project's decisions log), not a literal. No one-off layouts, duplicated components, magic numbers, screenshot-specific hacks, broken native gestures, or edits to unrelated screens.
- An approved idea conflicts with a technical or UX constraint → stop that part, explain the conflict, ask. Never quietly change the approved design.
- Follow this project's own workflow rules for branches/commits/collab claims (`ui-review.md` or the project's own docs say where those live); commit only on request. Large edits can go to an implementer subagent if the project has one.

## 7. Visual verification
Rebuild (if applicable), capture/collect the same states with the same flags → `after-<state>.png`; `compare.sh … Baseline=… Target=… After=…`; Read it. List discrepancies — spacing, alignment, type, hierarchy, icon size, radii, clipping, safe areas, sheet behaviour, aspect ratios, bars — and fix the real ones. Mockups are approximate (text rendering, exact sizes): do not pixel-chase differences that come from correct native rendering. A second opinion is cheap: `codex exec -s read-only -C <repo> "<list discrepancies between target and after>" -i target.png -i after.png`.

## 8. Functional verification
Walk the screen's flow where it is reachable; whatever needs manual interaction — ask the owner and say it was checked by hand. Run this project's own build-for-testing / targeted tests / lint-and-design-token checks / preflight gate (`project.json.gate`, if set) — say plainly which tests ran and which did not (a full test suite run is usually NOT run here — say so). An independent check by a `verifier` subagent or the owner on device is worth asking for. Say plainly what was not verified.

## 9. Design memory
Only what the owner approved goes into the project's decisions log at the path `ui-review.md` names, as the next entry: date, what was chosen, why, and one line on the rejected directions and the reason. If `ui-review.md` names no such log, record the same thing in the run's own `decision.md` only — do not invent a new project-wide document.
