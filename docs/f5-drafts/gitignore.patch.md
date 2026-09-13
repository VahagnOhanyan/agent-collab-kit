# Патч для .gitignore (Tripix)

Обе игнорируемые строки (`.collab/`, `.ui-review/`) остаются без изменений — переформулируются только комментарии над ними, которые описывают слой как часть этого репозитория.

---

## Комментарий над `.collab/` (строки ~180–187)

OLD:
```
# Collaboration state: the shared task/message/review/approval ledger the agents
# write at runtime (tools/collab/). It is per-workspace and high-churn — one file
# per record plus an append-only audit log — so it does not belong in git and
# would be a merge conflict on every branch. The LAYER is tracked
# (tools/collab/**, scripts/check-collab-config.mjs); only its state is not.
# Decisions that must bind everyone get promoted out of here into
# docs/decisions/ as an ADR, which is the mechanism that already exists for that.
.collab/
```

NEW:
```
# Collaboration state: the shared task/message/review/approval ledger the agents
# write at runtime. It is per-workspace and high-churn — one file per record plus
# an append-only audit log — so it does not belong in git and would be a merge
# conflict on every branch. The LAYER itself lives OUTSIDE this repository now —
# the machine-level kit at ~/agent-kit (installed release ~/.agent-kit/current;
# see docs/tooling/collab.md and ADR-0013) — and only an explicit `collab init`
# creates this directory, never implicitly. Decisions that must bind everyone
# get promoted out of here into docs/decisions/ as an ADR, which is the
# mechanism that already exists for that.
.collab/
```

---

## Комментарий над `.ui-review/` (строки ~189–192)

OLD:
```
# UI review runs (.claude/skills/ui-review): simulator screenshots, AI mockups,
# Codex JSON. Working material of one machine; what the owner approves is
# recorded in docs/design/design-decisions.md, which is tracked.
.ui-review/
```

NEW:
```
# UI review runs (skill `ui-review`, now user-level — ~/.claude/skills/ui-review,
# installed from ~/agent-kit): simulator screenshots, AI mockups, Codex JSON.
# Working material of one machine; what the owner approves is recorded in
# docs/design/design-decisions.md, which is tracked.
.ui-review/
```
