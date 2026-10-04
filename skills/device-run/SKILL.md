---
name: device-run
description: Build, install, launch and capture logs from an iOS app on the owner's PHYSICAL iPhone, with runtime flags the scheme cannot carry. Use when a question can only be answered by real device behaviour — traces, network traffic, GPU or thermal behaviour, A/B of a runtime flag — or when asked to "run it on my phone and watch the logs". Not for UI screenshots (see ui-shot) and not for tests (never boot the simulator for those).
---

# device-run — drive the app on the real phone and read its log

> **The machine's lock** (the kit's apple-toolchain rule): a build, an install and an uninstall go through `apple-lock`, as in the commands below. The live console capture (`process launch --console`) goes without the lock: it lasts the whole time the owner holds the phone.

The simulator cannot answer questions about GPU pacing, thermal state, Low Power Mode, real network or hardware decoders. This is the loop for the ones it cannot.

**The human drives the phone.** You build, install, launch with the flags you need, and capture the console. Then you say exactly what to tap and wait. The commands below are the ones that actually worked, not a reconstruction.

## Project config

Nothing project-specific lives in this skill. Run `collab project --json` (the `collab` binary is `$HOME/.agent-collab-kit/current/bin/collab`) to get `registryDir` and `projectId`; project data is then at `<registryDir>/<projectId>/`:

- `ui-review.json` — `{ project, scheme, bundleId, product, … }`, the same file `ui-review` and `ui-shot` read. Below, `<scheme>`, `<bundleId>` and `<product>` are those.
- `device-run.md` — everything else about this project on a device. Read it fully before step 0. It says: **which build configuration** to install (and which one the IDE's Run action builds instead — see "The trap" below), where the **DerivedData** is, the **runtime flags** the app understands and what each turns on, **where its log lines go** (a project logger that writes to stderr, or `os.Logger` under which subsystem), which **lines are the signal** and which are noise, what a **run must be checked for** before it is believed, and the project's own **hard-won lessons** with their dates.

**No project in the registry, or no `ui-review.json`.** Draft one by detection and show it to the owner — do not guess silently and do not write it yourself: schemes from `xcodebuild -list -json`, the bundle id from `PRODUCT_BUNDLE_IDENTIFIER` in the `.xcodeproj/project.pbxproj`. Agents cannot write the registry (`~/.agent-collab-kit` is hard-denied by the scope-guard hook); after the owner agrees, hand them the exact text and path. Without `device-run.md` the run still works, but you do not know the project's flags or which log lines matter: say so, and capture everything.

## 0. Find the device

```bash
xcrun devicectl list devices
```

Take the **Identifier** column UUID (it looks like `6D077F13-95F7-53F4-9FDF-DCAD1608C97A`). Use that one UUID for `devicectl install`, `devicectl launch` and a `generic/platform=iOS` **build** destination alike. Do not hardcode it; the phone can be re-paired.

**But NOT for a concrete `platform=iOS,id=` destination**, which is what `test`, `build-for-testing` and `test-without-building` need. Those take the HARDWARE id, and the coredevice UUID fails with a message that reads like the phone is missing rather than like the id is the wrong kind:

```
xcodebuild: error: Unable to find a device matching the provided destination specifier
```

Get the right one from the scheme, not from `devicectl`:

```bash
xcodebuild -scheme <scheme> -showdestinations 2>&1 | grep -E "platform:iOS, arch"
# { platform:iOS, arch:arm64, id:00008130-…, name:iPhone }
```

Two more failures of the same family, both transient and worth waiting out rather than working around:

- `Failed to install the app on the device` / `Timed out waiting for all destinations…` with `error:Device is busy (Preparing iPhone)` — the phone is indexing symbols after a fresh install. Re-run `-showdestinations`; when the `error:` clause is gone, it is ready.
- `generic/platform=iOS` cannot be used for `build-for-testing`: it fails with `Could not find test host … TEST_HOST evaluates to …`, because a generic destination never produces the host product path. Use the concrete one.

⚠️ **Running tests replaces the installed app.** `xcodebuild test` builds and installs its own copy of the host, so the binary on the phone afterwards is NOT the one you installed in step 2 — its hash changes even with identical sources. Re-install and re-print the hash before any capture that follows a test run.

Export it once per session:

```bash
xcrun devicectl list devices --json-output <scratchpad>/dev.json >/dev/null 2>&1
D=$(python3 -c "import json;print(json.load(open('<scratchpad>/dev.json'))['result']['devices'][0]['identifier'])")
```

`D` does not survive between tool calls — the shell is re-initialised each time. Paste the literal UUID into each command, or re-derive it at the top of every call.

If `list devices` shows `unavailable` or nothing, the cable or pairing is asleep. Poll it a few times a couple of seconds apart before concluding it is gone — it often comes back.

## 1. Build for the device

```bash
apple-lock xcodebuild -scheme <scheme> \
  -destination "generic/platform=iOS,id=$D" \
  -configuration <configuration> -allowProvisioningUpdates build 2>&1 \
  | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```

`<configuration>` is the one `device-run.md` names (normally Debug). `-allowProvisioningUpdates` is required; without it signing fails on a fresh keychain. Filter the output — a full device build is tens of thousands of lines.

If it fails with **"database is locked"**, Xcode is building the same DerivedData. Wait about 20 s and retry rather than working around it.

## 2. Install — and prove you installed what you built

### 2a. Before ANY action that touches the phone: check, then ASK

This gate covers **install, uninstall and launch alike** — not launch alone. Installing over a running app terminates it, so an install lands on another session's live capture exactly as hard as `--terminate-existing` does. Building is the only step that is free (bar the DerivedData lock).

**One device, several agents.** Sessions run in parallel and each one reaches for the same iPhone. Their run dies mid-scroll with `App terminated due to signal 15` and a truncated log, and they will not know why.

Two seconds, every time:

```bash
# Someone else streaming a console?
pgrep -af "devicectl device process launch" | grep -v "^$$ " || echo "device free"
# The app already running (and if so, under WHOSE flags)?
xcrun devicectl device info processes --device $D 2>&1 | grep -i <product> || echo "not running"
```

`pgrep -a` prints the other session's FULL command line, including its `--environment-variables` and its output path. That tells you what they are investigating and where their log is going, which is enough to decide whether to wait. Sanity-check a hit with `ps -p <pid>` before believing it: the pattern can match the shell running the `pgrep` itself, and a self-match reads as "busy" when the phone is free.

If another session is live: **stop.** Say so and ask the human — they know whether the other session matters. Attaching is not an option either; the running process carries the OTHER session's environment, so its flags are not yours and its log is not your experiment.

**And even when the check comes back clean, ask before you install and before you launch.** The human may be holding the phone themselves — mid-repro, showing someone, reading a screen you are about to blank. `devicectl` cannot see that; only they can. State what you are about to install (the hash) or launch (the flags) and wait for a yes.

### The trap

Two device configurations may coexist in DerivedData:

```
Build/Products/<configuration>-iphoneos/<product>.app   ← what the command above produces
Build/Products/<other>-iphoneos/<product>.app           ← what the IDE's Run action may produce
```

`device-run.md` says which configuration the IDE's Run action builds. Grabbing "the .app that is there" can install a build from hours ago, and you will attribute somebody else's behaviour to your change. A device run is normally a Debug build, which means **main-thread timings are inflated** — say so when you quote them. Behavioural facts (which stream rung, focus decisions, contention) are unaffected. Do not try to build a release-like configuration for a device install if its entitlements cannot be signed with a development profile: `device-run.md` says if that is the case.

Run 2a first and get the human's yes — this command can kill a live capture.

```bash
APP=<DerivedData>/Build/Products/<configuration>-iphoneos/<product>.app

apple-lock xcrun devicectl device install app --device $D "$APP" 2>&1 | grep -E "App installed|ERROR"
shasum -a 256 "$APP/<product>" | cut -c1-16      # record it
```

**Print that hash before every run and quote it in your findings.** In an A/B it is the only proof both arms ran the same binary; in a single run it is the only proof the phone is running your change at all.

For a clean-container run (first-launch behaviour, cache-growth measurements, anything where prior state is the variable), uninstall first — 2a applies to this too, and it throws away the app's whole container, so be sure that is what the human wants:

```bash
apple-lock xcrun devicectl device uninstall app --device $D <bundleId>
sleep 2
```

## 3. Launch with flags, capturing the console

### 3a. FIRST run 2a — check, then ask

`--terminate-existing` does exactly what it says: it kills the app out from under whoever else was capturing. Re-run the two commands in 2a and get the human's yes, naming the flags you are about to launch with. If another session is live, do not launch.

### 3b. Launch

This is the whole point: **runtime flags go on the launch command**, not in the scheme. Scheme diagnostic flags are invisible to git and do not apply when `devicectl` launches the app.

```bash
rm -f <scratchpad>/run.log
xcrun devicectl device process launch \
  --device $D --console --terminate-existing \
  --environment-variables '{"FLAG_ONE":"1","FLAG_TWO":"1"}' \
  <bundleId> > <scratchpad>/run.log 2>&1
```

**Run this in the background.** `--console` blocks for the entire life of the app — that is the capture. The human then drives the phone while it streams to the file. The flags are the ones `device-run.md` documents; do not guess names.

- `--terminate-existing` — kill whatever is already running, or you attach to a stale process launched from the home screen and get a mixture of two builds. Run 3a first: the thing it kills may be another agent's live capture, not a stale process.
- Launching from the home screen produces **no console output at all**. If the human opened the app themselves, relaunch it through this command.
- Filtering inline works, but only with line buffering: `... 2>&1 | grep --line-buffered -E "<tag>" > <scratchpad>/tag.log`. Prefer capturing everything and searching afterwards — you rarely know in advance which tag answers the question.

**Watch for `connection was invalidated`** in the capture — the console stream can drop mid-run and the file then simply stops growing while the app keeps going. Check the line count before analysing, and treat a run that died early as no run.

### If the app logs through `os.Logger`, add `OS_ACTIVITY_DT_MODE=YES`

The console shows only what reaches **stderr**. A project logger that calls `print` reaches it; `os.Logger(subsystem:category:)` goes to the unified log and does **not**. `OS_ACTIVITY_DT_MODE=YES` mirrors os_log to stderr — it is what Xcode itself sets when it runs an app, which is why those lines show up in Xcode's console and not in yours.

```bash
xcrun devicectl device process launch \
  --device $D --console --terminate-existing \
  --environment-variables '{"OS_ACTIVITY_DT_MODE":"YES"}' \
  <bundleId> > <scratchpad>/run.log 2>&1
```

Cheap sanity check before handing the phone over — count the lines of the subsystem `device-run.md` names; if that is 0, the capture is worthless. Harmless to always pass; set it by default unless you are measuring logging overhead itself.

### Three dead ends — do not re-derive them

- **`log stream --device`** — the flag does not exist on current macOS. Note also that `log` can be shadowed by a shell builtin: without `/usr/bin/log` you get `too many arguments`, which looks like a syntax error and is not.
- **`sudo log collect --device-udid …`** — works, but needs root, and `sudo` prompts for a password. Do not ask the owner for it; use `OS_ACTIVITY_DT_MODE` instead.
- **`xcrun devicectl device sysdiagnose`** — fails with `DiagnoseError error 0`, including with `-v`. Not a permissions issue and not fixable from here.

Consequence worth knowing: **you cannot retrieve a run you did not capture live.** os_log persists on the device, but every route to reading it back is blocked above. If the human already exercised the app before you attached, that data is gone — relaunch and ask again.

## 4. Drive it

Tell the human precisely what to do — "open item X, press Play, let it reach the third step, then say done". Vague instructions produce a log you cannot align to anything.

While waiting, do not poll the log every few seconds; it costs context and the run is not finished. Wait for the human. When they say it is done, stop the background task and read the file.

## 5. Read it

```bash
wc -l <scratchpad>/run.log                 # did it actually capture?
grep -c "ERROR" <scratchpad>/run.log       # did anything blow up? (the project's own error tag, from device-run.md)
grep -h "<tag>" <scratchpad>/run.log | sort -u
```

`sort -u` matters when a subsystem emits the same decision many times: deduplicate before counting anything, or you will report thirteen events as four hundred. Then check whatever `device-run.md` lists as "check before you believe a run" — a pair of lines that must always match, a probe that must have fired.

## 5a. A missing line is not proof — check a positive signal too

A zero count for "X happened" proves nothing by itself: it is equally consistent with "X genuinely never happens" and with "the human never actually triggered the code path that would log X". Before reading a 0 as evidence, find an independent line that fires whenever the SETUP condition occurred — not the disputed line itself — regardless of the outcome under test.

The shape of the mistake: a human is asked to "touch the map", and the capture has zero lines for the disputed behaviour AND zero lines for an independent signal that fires on any such touch. Both zero means the touch never reached the code at all — the human tapped instead of dragging — and the "confirmed" conclusion from that first run was wrong. Only a second run, asked for the specific gesture and checked against the independent line coming back non-zero, actually answered the question. A plausible-looking zero can mean "verified absent" or "never exercised", and only a second, independent signal tells you which.

## 6. If it is an A/B, two pairs minimum

A first A/B pair can read as a clear win and the second pair destroy it — the spread *inside* one arm was larger than the gap *between* arms.

- the same binary hash in both arms;
- uninstall + install between arms, so no container state leaks;
- the same network (wifi vs cellular moves numbers more than most flags);
- an in-app log line that names the arm, so you can prove which one ran;
- **at least two pairs**, and if the between-arm gap is smaller than the within-arm spread, the honest answer is "no effect", not "small effect".

## What this skill is not

- **Not for UI screenshots** — use `ui-shot` on the simulator.
- **Not for tests.** Never boot the simulator to run tests; `build-for-testing` only.
- Never print an access token, any prefix of one, or any URL containing one.
