# Accessibility — usable by everyone, checked where the change is

Loaded for `ux_domains: accessibility`, and worth a glance for any MEDIUM/HIGH change. Platform specifics (APIs, audits, exact numbers) live in the platform skills — on iOS `ios-accessibility` and `hig`.

## Per change, check what the change touched
- **Labels** — every control has a name that says what it does, not what it looks like ("Delete trip", not "trash icon"). Images that carry meaning have a description; decorative ones are hidden from assistive tech.
- **Targets** — interactive elements meet the platform's minimum size; small icons get a larger hit area, not a larger icon.
- **Text size** — the layout survives the largest text setting: wraps or scrolls, never truncates meaning or overlaps.
- **Contrast** — text and essential icons readable in light and dark appearance.
- **Not colour alone** — state (error, selected, disabled) is also shown by text, icon or shape.
- **Motion** — reduced-motion setting replaces large or parallax motion with fades or cuts; nothing essential is conveyed only by animation.
- **Order and grouping** — a screen reader visits elements in visual reading order; a card is one element with a combined label, not ten fragments.
- **Custom gestures** — every gesture-only action has an accessible alternative (a button, a menu, an accessibility action).
- **Focus after change** — after a sheet opens, an error appears or an item is deleted, focus lands somewhere meaningful, not at the top of the page.
- **Time limits** — nothing important disappears on a timer the user cannot extend.

## Severity guide
- Blocker: an action impossible without sight or without fine motor control (no label on the only button, gesture-only delete).
- Major: text cut off at large sizes, focus lost after a key action, state shown by colour only.
- Minor: suboptimal reading order, verbose labels.
