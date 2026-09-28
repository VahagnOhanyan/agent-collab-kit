# iOS — platform conventions for interaction and adaptive layout

Loaded for `ux_domains: interaction` or `adaptive-layout` on an iOS project. The exact facts come from the installed platform skills — `hig` (sizes, components, terminology), `ios-accessibility`, `swiftui-expert-skill` (layout, state, safe areas), `swiftui-iphone-duo` (variable width). This file says what to look at; those say the numbers and APIs. The project's design system wins over both.

## Prefer native behaviour
- Use system components and their default behaviour (navigation, sheets, menus, pickers, swipe actions) unless the product deliberately differs — then be consistent with the product, not with the platform.
- Standard gestures keep their standard meaning: edge swipe goes back, swipe down dismisses a sheet, long-press opens a context menu.

## Sheets
- Choose detents by content: a sheet that needs scrolling to reach its main action is at the wrong height.
- Decide what interactive dismissal does with unsaved input: block it and ask, or keep the draft — never silently lose it.
- Content behind a partial sheet stays meaningful (the selected item remains visible).

## Keyboard
- The focused field and the primary action stay visible above the keyboard.
- Return key does the expected thing (next field / submit); the keyboard is dismissible.

## Feedback
- Haptics confirm meaningful outcomes (success, error, selection change), not every tap.
- System alerts only for things that need a decision now.

## Adaptive layout
- Check the narrowest and widest supported widths, the largest Dynamic Type size, landscape if supported, and variable-width windows if the app supports them.
- Safe areas: nothing interactive under the home indicator or the camera housing; background can extend.
- One-handed reach: frequent actions within reach at the bottom; destructive ones not where the thumb rests.
- Long content: wraps or scrolls; no fixed heights around text.
- Do not branch layout on device model; branch on available size.

## Permissions and lifecycle
- Ask for a permission in context, after explaining why; handle denial with a working fallback and a way to Settings.
- Returning from background restores the user's place and refreshes stale data visibly.

## Appearance
- Both light and dark, with the project's tokens; no hard-coded colours that disappear in one of them.
