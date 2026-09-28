# Navigation — where the user is, how they got there, how they get back

Loaded for `ux_domains: navigation`.

## The user should always know
- **Where am I** — a title or context that matches what they tapped to get here.
- **How do I go back** — the platform's back behaviour works; back returns to where they came from, with scroll position and filters intact.
- **What will this take me to** — a control's label predicts the destination; no surprise modal from a list row.

## Choosing the container
- **Push (stack)** — drilling into detail of the same flow.
- **Modal / sheet** — a self-contained task with a clear finish (create, edit, pick); needs an explicit done and cancel, and a decision on what dismissing-by-gesture does to unsaved input.
- **Tab / section switch** — peers the user moves between freely; each keeps its own state.
Mixing these for the same kind of step across the product is a consistency defect.

## Entry points and discoverability
- The primary action of a screen is visible without scrolling or a menu.
- Hidden gestures are shortcuts, never the only way.
- A feature reached from several places behaves the same from each.

## State across navigation
- Returning to a screen does not reset what the user was doing unless that is the point.
- Deep links and notifications land on a screen with a way back to a sensible parent, not a dead end.
- After completing a task in a modal, the user sees the result where they started.

## Common defects
- Two back paths (button and gesture) that do different things.
- Sheet dismissed by swipe loses typed input without warning.
- Nested modals the user cannot see the bottom of.
- A new screen that duplicates an existing one with different behaviour.
