---
name: api-change
description: Change the shape of a request or response that other code parses — a field, a type, an enum value, a new endpoint or DTO. Walks the contract first (the schema record, the pair manifest, the consumer types), then the side registries (enum copies, shared constants, cache namespaces) and ends with the gates. Use when a presenter, a route schema, a consumer's data type, or an enum shared across sides changes.
---

# api-change — the shape on the wire changes in several places at once

The wire shape between a producer and its consumers is a **contract**, not a by-product of the producer's code. What a consumer must receive is written down first, and only then the code of both sides. A gate that compares a consumer's types with the contract through a manifest of pairs turns "I changed the presenter and the type but not the contract" into a red build, and "a new type with no pair" into a ratchet that can only go down.

## Project config

Nothing project-specific lives in this skill. Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`; the project's own knowledge is then in `<registryDir>/<projectId>/api-change.md`. Read it fully before step 1. It names: **who may edit** the contract and shared files (often only the lead session; an executor that needs the contract stops and says so), **where each registry lives** (the contract files, the pair manifest, the enum registry, the shared-constants file), **the consumers** and where their types are, the **gates** and what each is for, the **cache rules** for cached responses, the rules a **contract record** must follow in this stack, and the project's own history of traps.

**No project in the registry, or no `api-change.md`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself: look for a contracts directory under the tests, a manifest or registry JSON, scripts named `check-*contract*` / `check-*parity*`, and the CI workflow that runs them. Show the draft in chat and ask for confirmation. Agents cannot write the registry (`~/.agent-collab-kit` is hard-denied by the scope-guard hook); after the owner agrees, hand them the exact text and the path. If the project has no contract at all, say so and propose creating one before changing the shape — do not skip the idea because there is nothing to follow.

## Order — the contract first

1. **Who reads the field.** Search every consumer for the field name and the producer's domain for the presenter; look up the type's pair in the manifest. No pair is not a "free" type — it is a line in the unpaired baseline, and the pair will have to be made.
2. **The contract record** (the project's schema for what a consumer must receive; remember to export it, or the gate will not see it). The rules below were each learned on a trap; `api-change.md` adds the stack's own:
   - **required** is only what the consumer **hard-decodes**: read the decoding code, not the property's optionality (a `decodeIfPresent ?? ""` field is soft);
   - allow unknown fields for forward compatibility; casing is decided **per field**, not per API;
   - dates the consumer decodes strictly are checked with the project's strict date check, zone included; without a zone, only a plain string;
   - every new required field gets a **tripwire test**: a pathological value the contract must reject. A check that cannot fail is not a check.
3. **The manifest of pairs.** One pair per consumer type and contract; a tagged union is registered per variant. Ignored fields only with a reason.
4. **The producer**: presenter, service, schema of the domain, the contract-test fixture and the route tests if there are any. Fixtures use **real** values a column can hold (the defaults of the schema), not convenient ones: a green test on a value that never occurs in the database is an inert clause.
5. **The consumer types**: a newly hard-decoded field only if the contract requires it; otherwise optional. A synthesised decoder is fixed through optionality; a hand-written one is fixed in its code.
6. **Side registries** — check each; nothing links them automatically:
   - an **enum value** goes into EVERY copy and the project's enum registry (a copy checked as a subset only catches extras — when adding, check the copies by eye);
   - a **number both sides know** (a limit, a batch size, a TTL) goes in the shared-constants file;
   - a **cached response** whose shape changed needs a namespace bump, and anything that depends on the viewer is keyed by viewer;
   - **another consumer** (web, a second client) reads the field → its own schema and type, parsed at the boundary.

## Gates and tests — before the report, not before the push

Run the gates `api-change.md` lists, those that apply to what you touched (contracts and pairs; enum parity if you touched an enum; shared constants if you touched a number; cache namespaces if you touched a cached endpoint), then the producer's contract and route tests, then the project's all-gates command. A hook that runs the matching gate after every edit of a contract file exists in the kit's project settings — its red output is fixed at once; the other gates are run by hand.

## Do not

- Update a baseline to "remove" a new unpaired type. A baseline only goes down; making the pair is the only way out. A baseline changes in a **separate commit**.
- Weaken a contract (`nullish` on a hard-decoded field) to pass a test: that moves the failure from CI to the user's screen.
- Change a rule that **both sides compute** (a lifecycle, a phase, conflicts, a polyline) on one side only. One side owns it, and the cases live in a shared fixtures directory — `api-change.md` says which side.

## Report

The three records (contract, manifest, consumer types) and what changed in each; which gates ran and with what output; which consumer tests cover the decoding (and which suites were not run); what is left out of scope (enum copies on the other side, web).
