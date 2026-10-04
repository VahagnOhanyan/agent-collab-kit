---
name: verify
description: Independent check of finished work before anyone says "done" — gates, build, targeted tests, diff within the plan, mutation control, an honest list of what was not checked. Use before declaring any task done, before a commit is requested, or when asked to "verify" or "check".
---

# verify — "done" is not said by the author

The author of a change does not decide that it is done. Either the read-only `verifier` subagent decides, or a person on the real device does. This skill is what gets checked and how, the same for the subagent and for a lead session that has to check on its own.

## Project config

Nothing project-specific lives in this skill. Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`; the project's own knowledge is then at `<registryDir>/<projectId>/`:

- `verify.md` — everything this skill needs to know about the project, in prose. Read it fully before step 0. It names: the **gate command** (the one that runs every cheap check at once), the **build command**, how to run **targeted tests** per area (and which suites must NOT be run by an agent), which paths are **functional code** (so a change there needs a test and a mutation), the **contract / interface checks**, which **baseline files** are ratchets, the project's own **rules a diff must not break**, and the project's own entries for the excuses table below.
- `verify.json` (optional) — the same facts as data, when a tool wants them: `{ "gate": "<command>", "build": "<command>", "tests": { "<area>": "<command>" }, "functional_paths": ["…"], "baselines": ["…"] }`.

**No project in the registry, or no `verify.md`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself: look for a script named like `preflight`, `check`, `ci` or `test` in the repo root and `scripts/`, a `Makefile`, `package.json` scripts, the CI workflow files (they are the project's own list of gates), and the build system's own command. Show the draft in chat and ask for confirmation. Agents cannot write the registry (`~/.agent-collab-kit` is hard-denied by the scope-guard hook), so after the owner agrees, hand them the exact text and the path `<registryDir>/<projectId>/verify.md`. Until it exists, say in the verdict which steps could not be run for want of it — that is "not checked", not a pass.

## Path A — delegate to `verifier` (the default)

Give it the **plan file** (an absolute path, never `~/…` — the read-only hook does not let a `~` through), the **owner's original request** and the **diff** (`git diff --stat`, the list of files). A retelling of the plan is not a substitute: the verifier checks against the plan's acceptance criteria and its "Verification" section. Prompt:

```
Plan: <absolute path to the plan file> (vN) — the Verification section and the acceptance criteria
Owner's request: <close to the words>
Collab task: <id of the product task, if there is one>
Mutation control: <the author's report — tests, mutations, run counts>
Diff: <git diff --stat HEAD -- <the task's files>>
Known-red tests are marked as skipped with a reason — do not unskip them.
Do not run a suite the project says only the owner runs. Verdict in the format of the verifier agent.
```

A subagent declared in this session is visible only from the next one. If `verifier` cannot be found, check on your own by path B and say that there was no independent check.

## Path B — check it yourself, in order

0. **Freeze the reference point.** `git rev-parse --short HEAD`, `git status --porcelain`. The tree is shared: other people's dirty files are called theirs — not credited to the author, not "fixed".
1. **Diff within the plan.** Every changed file is explained by the plan or goes into an "unplanned" list. Generated files, "never ship on" flags and baseline files get their own line. A task above L0 with no plan file is "not checked: no plan", not a FAIL (a rule, not a gate).
2. **Gates.** Run the project's gate command. Red is FAIL without discussion.
3. **Build.** Run the project's build command. If the tree does not compile because of somebody else's work in progress, build a **copy**: `git archive HEAD | tar -x -C <scratchpad>/tree`, copy the task's files over it, build there. "Did not build because of another file" is written as that, with the file's name.
4. **Targeted tests.** Run the tests that cover the change, the way `verify.md` says, never a suite it reserves for the owner. Tell "passed" from "skipped" by the runner's counters, not by the exit code: a skipped suite is also green, and a run of **zero** tests is a failure. List the test classes or files that cover the change (existing and added), and say plainly which suites were not run.
   - 4a. **Tests and mutation control.** If functional code changed (the paths `verify.md` names) or tests did: by the author's report and the diff, (1) the tests that must catch the change are named and are in the diff; (2) for every "fixed X" there is a **mutation** — a deliberate break after which exactly the test that must catch it fails — with figures: "failed N of M runs, deterministic or probabilistic". No mutation or no figures is a FAIL: "no negative control". Do not repeat the mutation run yourself: take the figures from the report and list them under "not checked"; a report that disagrees with the diff is a finding. The exception is an L0 change with no change of behaviour, named as such.
5. **Interfaces and contracts.** If a boundary others depend on was touched (an API shape, a shared constant, an enum copied in several places, a public module surface), run the checks `verify.md` names for it, and look yourself: is a newly hard-decoded field required in the contract? is a new enum value in every copy?
6. **Ratchets are not refrozen.** `git diff --stat HEAD -- <baseline files>` is empty, or a growth is explained and goes in a separate commit.
7. **Negative control.** For every "fixed X": what would be visible if X had not been fixed, and was that checked. A test that is green without the fix proves nothing; a negative test needs a positive control beside it.
8. **The project's own rules.** The list in `verify.md`: user-facing wording, tokens instead of literals, layering, migrations declared, and so on.
9. **Red flags: a diff that weakens a check.** Each one is FAIL until the author explains it in the plan or the report. Try `git diff -U0 HEAD -- <files>`; if the read-only hook refuses a pipeline with `grep`, read the diff by eye.
   - a new or widened skip / `only` / `xit`; a deleted or commented-out test or assertion;
   - an assertion replaced by a weaker one (an exact value → "not nil / not empty");
   - suppression instead of a fix: a linter disable, a type-checker ignore, an empty catch, a swallowed error where it used to show;
   - a threshold, timeout, limit or iteration count loosened, a comparison tolerance widened;
   - a test's expectation changed in the same diff as the code it was failing for — fitting to the result, not checking;
   - a baseline update, a baseline that grew, `--no-verify`, `--force`.

## Excuses "done" has already broken on

When you hear one of these — from the author, from yourself, or in a subagent's report — it is not evidence, it is a reason to check. These are the general ones; `verify.md` adds the project's own, with their dates.

| Excuse | Why it is not evidence | What counts |
|---|---|---|
| "The merge had no conflicts, so it builds" | A merge tool compares text, and a module boundary is an access level | A build after any merge that touched a file inside a module |
| "The run is green" with zero tests or a wall of skips | A skipped suite is green too; a test run against the wrong target says "0 tests" | The runner's counters: how many ran, how many skipped. Zero is a failure |
| "The test runner passed" after a source edit with no rebuild | Without a rebuild it runs the old binary — your edit was not tested | Rebuild after any source edit; the binary's modification time |
| "The test is green, so the capability works" | The test checked a state, not that the action is available at all | An assertion on the capability (the element is there, the action is doable) |
| "There is no line X in the log, so the branch or gesture did not fire" | The absence of a line proves nothing, and some environments hide log levels entirely | A positive line from the thing itself, read after the capture has ended |
| "The parameter defaults to false, so it is called with false" | A default is not a call | Open the call site and read the argument that is passed |
| "By the code the symptom should be gone" | A defect seen on a device is closed by a capture from the device, not by reasoning | The symptom is gone in the device's log |
| "The debt got smaller / the gate got greener after moving files" | A check keyed to paths does not fail after a move — it stops counting | The gate's numbers before and after the move |
| "A test died with a connection error — I will fix the test" | A shared machine resource (a simulator, a port) collided with another session | Who holds the machine's lock; retry later instead of editing the test |
| "The mutation was not caught — I will rewrite the test again" | If the cause is structural (a second independent point of the same condition, a runtime's behaviour), it is a finding for review, not a defect of the test | One attempt, the cause in one line in the test and the plan, the mutation raised with the architecture review |
| "The executor wrote that it is done and checked" | An author's statement is a candidate, not the truth | Your own run, the diff, a screenshot |

## Discipline of runs

- **Budget.** Two or three red runs on the *harness* (not on the code) — stop, report honestly, ask. Do not hammer.
- **One variable per run.** If you changed both the code and a test's expectation you do not know what worked.
- **Re-read before you run.** Half of the false claims are refuted by code that is already open; a search takes seconds, a build takes minutes.
- **One run, every hypothesis; capture to a log and search it many times.** Do not run the suite twice for a different search.
- **Do not mutate production code to check a test.** The broken variant is a test-only double. If a mutation cannot be avoided: before editing, copy the file aside and take its `shasum`; put it back only with `cp`, and compare the `shasum`. Never `git checkout`, `git restore` or `git stash`: they bring back the committed version and erase other people's uncommitted work in a shared tree.
- **Do not open a second edit until the first is checked.** Two unfinished things is nothing done.
- When the machine has a shared lock for builds and simulators (the kit's apple-toolchain rule), take it for every such command.

## Verdict format

**PASS** or **FAIL** on the first line. A table: step → command → result (one to three lines of output). Then "Unplanned files", "Not checked" (what and why — "tests were not run" is better than "it should work"), and "Negative control" for every claim. On a FAIL — the smallest step to a PASS.
