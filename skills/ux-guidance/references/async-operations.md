# Async operations — anything the user waits for

Loaded for `ux_domains: async-feedback`: uploads, exports, rendering, sync, long network calls, background processing the user can see.

## The user must always be able to answer three questions
1. **Is something happening?** — visible within ~1 s of the action; an indicator scoped to what is busy, not the whole screen, unless nothing else is usable.
2. **How far along / how long?** — determinate progress when the work is measurable; indeterminate only when it genuinely is not. Never a bar that jumps back or stalls at 99% for long.
3. **What happens if I leave?** — say it or make it obvious: continues in background, pauses, or is cancelled.

## States to design, not discover
- idle → started → in progress → succeeded / failed / cancelled; plus **resumed after return** and **interrupted** (app killed, network lost, low storage).
- Success: the result is shown or reachable in one step; not only a transient toast the user may miss.
- Failure: says what failed in user terms, keeps what was done, offers retry that does not redo completed work.

## Leaving and returning
- Background work that continues must still show its real state on return — not a fresh empty screen, not a stale "in progress" for a job that finished or died.
- If the platform may suspend the work, either say it will pause or finish the critical part first.
- Completion while away: notify only if the user would want to come back for it; a notification needs a destination.

## Cancel and retry
- Long work is cancellable; cancel is immediate in the UI even if cleanup continues.
- Cancel of something partly done: say what is kept.
- Retry is idempotent from the user's view — no duplicate posts, charges, uploads.

## Common defects
- Double submission because the button stays enabled while busy.
- Spinner that never ends on a silent failure (no timeout, no error path).
- Progress tied to the screen: leave and come back, progress is gone though the job runs.
- "Done" shown before the result is actually available.
