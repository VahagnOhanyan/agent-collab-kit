---
name: ui-shot
description: Build, launch and screenshot an iOS app on the simulator so its UI is judged on pixels, not just on view code. Use when asked to look at a screen, critique a layout, verify a UI change visually, or "show me how X looks". Captures a PNG that is then read and reviewed against the project's own design system.
---

# ui-shot — see the real UI, then critique it

> **The machine's lock** (the kit's apple-toolchain rule): Xcode and the simulators are shared by every session on the machine. A build and `simctl boot/install/launch` go only through `apple-lock`, as in the commands below; if it is busy the wrapper waits and says who holds it. Never shut down somebody else's simulator.

Goal: get a real rendered screenshot of a given screen into context, so UI feedback rests on pixels — spacing, contrast, alignment, tap targets — and not on a guess from `body`.

## Project config

Nothing project-specific lives in this skill. Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`; project data is then at `<registryDir>/<projectId>/`:

- `ui-review.json` — `{ platform, project, scheme, bundleId, product, device, appearanceNote? }`, the same file the `ui-review` skill reads. `project` is the `.xcodeproj` (or workspace) inside the repo, `scheme` and `bundleId` name what to build and launch, `device` is the simulator to use.
- `ui-shot.md` — everything else this skill needs to know about the project. Read it fully before step 1. It says: where this machine's **DerivedData** for the project is (see step 2 for why that matters), **how to reach a screen** (deep links, launch flags, a debug menu, who to ask), the **design system** to judge against (the spacing scale, type scale, colour tokens, radius scale, the shared surfaces and components), the **brand rules** (the user-facing name, strings that must never appear), and known **log noise** to ignore.

**No project in the registry, or no `ui-review.json`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself: schemes from `xcodebuild -list -json` in the repo; the bundle id from `PRODUCT_BUNDLE_IDENTIFIER` in the `.xcodeproj/project.pbxproj`; the device by asking, or a reasonable current simulator that the owner confirms. Show the draft in chat and ask for "yes". Agents cannot write the registry (`~/.agent-collab-kit` is hard-denied by the scope-guard hook), so after the owner agrees, hand them the exact text and the path of `ui-review.json` (it is data, and is still placed by hand). For `ui-shot.md`, save the draft as a file in your scratchpad directory and give the owner ONE command to run themselves: `collab notes install ui-shot <that file>` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`; run it in the project folder, or add `--project <id>`) — it shows what would be written and asks them to type the skill's name. Without `ui-shot.md` the screenshot can still be taken, but the review has no design system to judge against: say so, and judge on general grounds only (the checklist below).

## Procedure

### 1. Pick or boot a simulator
```
xcrun simctl list devices booted | grep -i booted
```
If one is booted, reuse it (take its UDID). Otherwise boot the `device` from the config:
```
apple-lock xcrun simctl boot "<device>"   # then: open -a Simulator
```

### 2. Build for the simulator
Build INTO the project's existing DerivedData — do NOT use a fresh `-derivedDataPath` such as `/tmp/...`. A fresh path forces SwiftPM to resolve the packages again, and a package's binary artifacts may not be fetchable: resolution fails but `xcodebuild` can still exit 0 and leave an empty `.app` husk (no `Info.plist`, no executable) that `simctl install` rejects with "Missing bundle ID". Use the resolved directory that `ui-shot.md` names (confirm with `ls -d ~/Library/Developer/Xcode/DerivedData/<product>-*`; the folder name is stable per machine).
```
apple-lock xcodebuild -project <project> -scheme <scheme> -configuration Debug \
  -destination 'platform=iOS Simulator,name=<device>' \
  -derivedDataPath "$DD" build | tail -6
```
A build of a large app is slow: run it in the background and wait to be told it is done. If the tree is unchanged since the last build, skip it and install the `.app` already in that DerivedData. Sanity-check the product before installing: it must hold an `Info.plist` and the executable.

### 3. Install and launch
```
APP="$DD/Build/Products/Debug-iphonesimulator/<product>.app"
apple-lock xcrun simctl install booted "$APP"
apple-lock xcrun simctl launch booted <bundleId>
```

### 4. Navigate to the target screen
The app may open on a default tab. To reach a given screen: prefer a deep link if the project has one (`xcrun simctl openurl booted "<scheme>://..."` — check the app's URL handling before assuming one exists), or the route `ui-shot.md` gives. Otherwise ask the person to land on the screen and take the screenshot afterwards: driving taps with `simctl` is not available.

### 5. Screenshot, then read it
```
OUT=<scratchpad>/ui-shot-$RANDOM.png   # vary the name; never reuse one
xcrun simctl io booted screenshot "$OUT"
```
Read the PNG so it enters context, and review it.

## What to evaluate

Score the screenshot against these, and phrase every fix in the project's own tokens and components (from `ui-shot.md`), not in raw numbers:

- **Spacing** — are gaps and padding on the project's scale? Inconsistent margins?
- **Hierarchy and type** — does emphasis follow the project's type scale? Right weight and size?
- **Colour and contrast** — tokens, not ad-hoc values; readable in both light and dark; semantic colours used as the project defines them.
- **Tap targets** — interactive elements are at least 44 pt.
- **Surfaces and radius** — shared surface modifiers and the project's radius scale, not one-off styling.
- **Reuse** — could this be a shared component instead of a bespoke layout?
- **States** — loading, empty and error are handled, with the shared state views if the project has them.
- **Dynamic Type and safe area** — does the layout survive larger text, the notch and the home indicator?
- **Dark mode** — capture both appearances when contrast is in question: `xcrun simctl ui booted appearance dark|light` (if the app has its own appearance setting that ignores the system one, `ui-review.json` says so in `appearanceNote`).
- **Brand** — any string the project's brand rules forbid is a bug.

## Output format

A short verdict, then findings grouped **Must-fix / Should-fix / Polish**, each with the concrete token or shared component to use. Cite the screenshot for every claim.

## Notes

- Do not pre-render or pre-set a camera or other live state to fake a screenshot — capture the live render, unless `ui-shot.md` says the project does it deliberately.
- Log noise the project knows about is in `ui-shot.md`; ignore exactly that and nothing else.
