# ui-review — Tripix (Aweiro) project notes

Read this fully before step 0 of the ui-review skill. Product name in UI is **Aweiro**; `Tripix` is the historical code/identifier name — a visible "Tripix" in the UI is a bug.

## Reaching screen states

| Screen / state | How to reach it |
|---|---|
| Feed (default tab) | plain launch |
| Trip Detail | `--env TRIPIX_DEBUG_OPEN_TRIP_ID=<id> [--env TRIPIX_DEBUG_OPEN_CONTEXT_ID=<ctx>] --wait-for 'apply startup route ready'` |
| Design-system catalog section | `--env TRIPIX_DEBUG_DESIGN_CATALOG=<section>` |
| Sheet / date-picker stands | `--env TRIPIX_DEBUG_SHEET_STAND=1\|large\|add`, `--env TRIPIX_DEBUG_DATE_PICKER_STAND=1` |
| Anything needing taps, scrolling, a keyboard | ask the owner to navigate in Simulator, then `capture.sh … --no-launch` |

Trip ids: `curl GET $AWEIRO_API_BASE_URL/trip` with header `x-seed-token: $AWEIRO_SEED_TOKEN` and `x-as-user: <simulator user id>` (the app's prefs key `mostRecentBackendUserId`). **Use `curl`, not Python** — Cloudflare rejects `urllib`'s default user agent with error 1010. Both env vars are already set for you; never print or log their values. Creating or deleting data needs the owner's OK first.

## The AppearanceManager trap

The app's own in-app appearance setting (`Tripix/Utils/AppearanceManager.swift`) defaults to dark and **ignores the simulator's system appearance** unless it is explicitly set to "System" inside the app. `capture.sh --appearance light` alone does not produce a light screenshot — check/set the in-app setting first, or capture in the state the app is actually in.

## Signed-in simulator

Only the `iPhone 17 Pro Max` simulator holds the owner's signed-in session — there is no login bypass. **Never erase it.** Do not pre-set a map camera or otherwise fake a shot.

## Design-system docs and status

- `.ai/design-system.md` — compact, machine-facing design-system context (tokens, "Atlas Glass" identity, status labels).
- `docs/design/design-decisions.md` §1 (CONFIRMED decisions — the decisions log; write new approved entries here as the next `C-<n>`) and §6 (migration order, once the design system itself is approved).
- `.claude/rules/design-system.md`: design-system v1 status is **PROPOSED, not yet approved** — the rules in it already apply, but it explicitly bans broad visual changes to *existing* screens until approved. The owner's explicit approval in the ui-review skill's step 5 is what authorizes a given screen's change; say so in the approval summary every time.
- Order for any UI work: existing component (`docs/design/components.md` → `Tripix/View/Common/` → `Modules/SharedUI/Sources/Components/`) → existing pattern (`docs/design/patterns.md`) → tokens (`TravelColor` · `TravelTypography` · `TravelSpacing` · `TravelRadius` · `AppShadows` · `Motion` · `AweiroIcon`; surfaces via `.travel*Surface()` / `.glass*()`). A missing value is a design decision (an entry in `design-decisions.md`), never a literal.

## Copy rules

User-facing strings say **"Aweiro"**, never "Tripix". Use `LocalizedStringKey` with proper plural variants. Do not use **"your"** in copy (house style).

## Env / token names (names only — never log or paste values)

- `AWEIRO_API_BASE_URL`
- `AWEIRO_SEED_TOKEN`
