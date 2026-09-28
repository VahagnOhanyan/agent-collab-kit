# Maps — interaction on a map or globe

Loaded for `ux_domains: maps`. General principles; the project's own map rules (SDK, camera, styles) always win.

## Gestures belong to the map first
- Pan, zoom, rotate, tilt are expected; an overlay that captures them in part of the map is a conflict, not a feature.
- Taps on markers vs taps on the map: the target must be unambiguous; nearby markers need grouping or a chooser, not a guess.
- Long-press or drag to edit (move a pin, reshape a route) needs a visible affordance and feedback while dragging; accidental drags must be undoable.

## Camera
- The camera moves only in response to the user or to an action they took; unrequested camera jumps lose their place.
- After a programmatic move, the user can see why (the selected item is visible, not under a sheet or controls).
- Respect reduced-motion settings: long fly-overs become cuts or short transitions.

## Overlays and sheets
- A bottom sheet or panel over the map must leave the selected item visible, or move the camera to keep it visible.
- Controls do not cover the content they act on.

## Selection and state
- Selected item is visually distinct and its details reachable in one step.
- Deselecting is obvious (tap elsewhere, close control) and consistent.
- Filters or layers that hide items say so; an empty map explains why it is empty.

## Performance is UX
- Stutter during pan/zoom reads as broken; dense data needs clustering or level-of-detail.
- Loading tiles or data shows progress in place, not a blank map.

## Accessibility
- Everything reachable by tapping a marker is also reachable without the map (a list or a focusable element).
- Markers have labels for screen readers; a map is not the only way to choose a place.
