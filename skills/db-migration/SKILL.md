---
name: db-migration
description: Change a database schema and ship the migration safely — expand/contract design, declaring a destructive step, a local check, what CI does with it after the push, a rollback rehearsal and matrix. Use when a schema file changes, a migration is added, a column, enum value or index is dropped, renamed or made NOT NULL, or a rollback is being discussed.
---

# db-migration — a schema is rolled back by a dump, so go forward carefully

Most migration tools are forward-only and run on every release, often more than once (each service's entrypoint, a release script). Rolling back the application image is a button; rolling back the schema is a restore of a dump and a loss of the rows written since. Everything below follows from that.

## Project config

Nothing project-specific lives in this skill. Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`; the project's own knowledge is then in `<registryDir>/<projectId>/db-migration.md`. Read it fully before step 0. It names: the **migration tool** and where the schema and migrations live, the **commands** that create, apply and validate a migration locally, **how a destructive migration must declare itself** and which gate checks that, the **guards** on things the tool does not model (hand-written indexes, extensions), where **enum copies** live outside the database, **what CI does** on a push and on a release, the **rollback runbook**, and anything about **which environment is production** that is still open.

**No project in the registry, or no `db-migration.md`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself: the migration directory and the tool's config in the repo, the scripts in `package.json` or a `Makefile`, the CI workflow files (they say what runs on a push and a tag), a runbook under `docs/`. Show the draft in chat and ask for confirmation. Agents cannot write the registry (`~/.agent-collab-kit` is hard-denied by the scope-guard hook), and nothing but the owner's own terminal may, because these notes are instructions an agent obeys. So after the owner agrees, save the draft as a file in your scratchpad directory and give them ONE command to run themselves: `collab notes install db-migration <that file>` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`; run it in the project folder, or add `--project <id>`). It shows what would be written and asks them to type the skill's name; the note then lands at `<registryDir>/<projectId>/db-migration.md`. Until then, do not guess at a destructive rule: ask.

## 0. Design it as expand / contract

- A new column or table is an **expand**: additive, and the old code keeps working.
- A drop, a rename, `SET NOT NULL`, a type change, or `ADD COLUMN NOT NULL` with no default is a **contract**: it goes in a release **later** than the one that stopped using the old thing, and never in the same one that introduces its replacement.
- A new enum value is an expand for the database, but a hand-kept copy elsewhere (a validation schema, a client type, a web type) needs it too: `db-migration.md` names the registry of copies and the gate that compares them. Removing an enum value is a contract with the full cycle.

## 1. Write the migration

Use the tool's "create but do not apply" mode, so the SQL exists and can still be edited (`db-migration.md` has the command). A destructive migration declares itself **in the SQL**, in the form the project's gate expects, or the gate will not let it through. An allowlist file the gate keeps is history, not a shelter: nothing is added to it to silence the guard. If the project keeps guards for things the tool does not model (partial or trigram indexes, extensions), dropping one means updating its guard too.

## 2. Apply it locally and check

Run what `db-migration.md` lists, in this order: apply to the local database and regenerate the client; validate and format the schema; lint and the architecture checks; the tests that touch the changed code; the project's destructive-migration gate; the **rollback rehearsal** (the previous image running over a schema that is "ahead"); the project's all-gates command. Two things to read honestly: integration tests that need a test database are **skipped with a green exit code** when it is missing — the report says "skipped", not "passed"; and a rehearsal that needs a tool or a database the machine lacks prints a note and skips — say so. If the project's notes say an extension is not installed locally, the code must degrade without it.

## 3. What happens after the push — know it before the push

`db-migration.md` has the table. The shape is always the same: a push to the main branch may migrate a dev environment; a release tag takes a dump, migrates, then ships the image; every push runs the destructive and rollback gates against a real database. **No migration is run from a laptop against a server**, not even "just once": `ssh … migrate deploy` is not a path.

## 4. Rollback — read it before the release, not during

The runbook the notes name has the matrix "additive / destructive × data present / absent". An additive release rolls back by re-running the workflow with the old ref, losing nothing; a destructive release with no data is a restore of the pre-release dump; a destructive release **with** data has no "back to how it was". That is the reason for expand / contract. If the runbook has an open question (which environment is production right now), ask the owner before any action.

## Report

The migration (its directory), its type (expand or contract), the markers in the SQL; which gates ran and which were skipped for want of a database; the enum copies on other sides (what changed, what is out of scope); what the dev environment will see after the push.
