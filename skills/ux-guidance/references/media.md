# Media — photos, video, audio, galleries, players, pickers

Loaded for `ux_domains: media`.

## Loading and quality
- A placeholder with the final size reserved, so the layout does not jump when the image arrives.
- Progressive: something visible fast, full quality after; never a blank cell where a thumbnail is expected.
- Failed media shows a failed state with retry, not an eternal placeholder.

## Playback
- Autoplay only muted, and only where the context makes it expected; sound starts only on the user's action.
- Play/pause, position and mute are always reachable; the current state is visible.
- Leaving the screen stops or backgrounds playback as the user would expect; returning resumes where they were if it is the same item.
- Respect system mute/silent settings and reduced motion for decorative motion.

## Browsing and viewing
- Swipe between items in a viewer; the position ("3 of 12") when the set is finite.
- Zoom and pan in a viewer do not fight the dismiss gesture.
- Dismissing a full-screen viewer returns to the same item in the grid.

## Picking and uploading
- Ask for access at the moment it is needed, with the reason; handle limited or denied access with a way forward.
- Show what was picked before committing; allow removing an item.
- Upload progress per item; a failed item can be retried alone.

## Sensitive content
- Content the user might not want shown (private, blurred, restricted) stays hidden in previews, thumbnails, share sheets and notifications too.

## Common defects
- Grid jumps while images load.
- Video keeps playing audio after the user left the screen.
- Dismiss gesture triggers while the user is zooming.
