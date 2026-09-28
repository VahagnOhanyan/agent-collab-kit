# Destructive actions — delete, discard, remove, overwrite, leave

Loaded for `ux_domains: destructive-action`.

## Decide the protection by what is lost
| Loss | Protection |
|---|---|
| Trivially recreated (a filter, a draft line) | none, or undo |
| User content, recoverable | undo (preferred) or a soft delete with restore |
| User content, unrecoverable, or affects others (shared item, other participants) | explicit confirmation that names the item and the consequence |
| Irreversible and large (account, a whole collection) | confirmation plus a deliberate extra step (type the name, second screen) |

Undo beats confirmation: confirmation dialogs get dismissed by habit, undo does not interrupt.

## Placement and appearance
- Not the default or most prominent action; not adjacent to the frequent action where a slip hits it.
- Visually marked as destructive by the platform's convention, text says what happens ("Delete trip", not "OK").
- Not reachable by an accidental gesture alone (a swipe that deletes without undo is a blocker).

## Confirmation content
- Names the object ("Delete "Lisbon 2025"?"), states what goes with it (photos, shared copies), and whether it can be restored.
- Destructive button labelled with the verb; cancel is the safe default.
- No double negatives, no "Are you sure?" with nothing else.

## After the action
- Immediate feedback that it happened and where the user is now (not left on a screen of a deleted item).
- If others are affected, say what they will see.
- Failure to delete is reported; the item is not shown as gone when it is not.

## Common defects
- Delete offered in a list with no way to tell which item a swipe targets.
- Confirmation that does not name the item.
- Navigating back into a deleted item's screen.
- Leaving a flow with unsaved changes silently discards them.
