#!/usr/bin/env bash
# Deterministic simulator screenshot for the ui-review workflow.
#
#   tools/ui-review/capture.sh OUT.png [options]
#     --install                 install the Debug build from DerivedData first
#     --env KEY=VALUE           launch env for the app (repeatable), e.g. TRIPIX_DEBUG_OPEN_TRIP_ID=<id>
#     --appearance dark|light   system appearance (default: dark). The app follows it only when its
#                               own appearance setting (AppearanceManager) is "system".
#     --wait SECONDS            settle time after launch (default 14)
#     --wait-for REGEX          instead of a fixed wait, poll the app's stdout for this line (timeout 60 s),
#                               e.g. 'apply startup route ready'; then settle 6 s for the map
#     --no-launch               screenshot the current state without relaunching (owner navigated by hand)
#
# Same device, status bar and appearance every time, so a before/after pair
# differs only where the UI does. Device: $UI_REVIEW_DEVICE, default
# "iPhone 17 Pro Max" — the simulator that holds the owner's signed-in session
# (there is no login bypass; erasing it loses the session).
set -euo pipefail

out="${1:-}"; [ -n "$out" ] || { sed -n '2,17p' "$0" >&2; exit 64; }
shift
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
install=0; launch=1; appearance=dark; wait_s=14; wait_for=""
envs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) install=1 ;;
    --env) envs+=("SIMCTL_CHILD_$2"); shift ;;
    --appearance) appearance="$2"; shift ;;
    --wait) wait_s="$2"; shift ;;
    --wait-for) wait_for="$2"; shift ;;
    --no-launch) launch=0 ;;
    *) echo "capture.sh: unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

device="${UI_REVIEW_DEVICE:-iPhone 17 Pro Max}"
bundle=com.vahagn.Tripix
udid="$(xcrun simctl list devices available -j | python3 -c "
import json, sys
name = sys.argv[1]
for runtime, devs in json.load(sys.stdin)['devices'].items():
    for d in devs:
        if d['name'] == name and 'iOS' in runtime:
            print(d['udid']); raise SystemExit
" "$device")"
[ -n "$udid" ] || { echo "capture.sh: no available simulator named '$device'" >&2; exit 69; }

xcrun simctl bootstatus "$udid" -b >/dev/null
open -a Simulator
mkdir -p "$(dirname "$out")"

if [ "$install" = 1 ]; then
  app="$(ls -d "$HOME"/Library/Developer/Xcode/DerivedData/Tripix-*/Build/Products/Debug-iphonesimulator/Tripix.app 2>/dev/null | head -1)"
  [ -f "$app/Info.plist" ] && [ -f "$app/Tripix" ] || { echo "capture.sh: no complete Debug Tripix.app in DerivedData — build first (see ui-review skill)" >&2; exit 66; }
  xcrun simctl install "$udid" "$app"
fi

xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3 --dataNetwork wifi
current="$(xcrun simctl ui "$udid" appearance)"
if [ "$current" != "$appearance" ]; then
  xcrun simctl ui "$udid" appearance "$appearance"
  sleep 3   # SpringBoard restyles; a launch during it is refused ("denied by service delegate")
fi

if [ "$launch" = 1 ]; then
  log="${out%.png}.launch.log"
  : >"$log"
  launched=0
  for attempt in 1 2 3; do
    if env "${envs[@]+"${envs[@]}"}" xcrun simctl launch --terminate-running-process \
         --stdout="$log" --stderr="$log" "$udid" "$bundle" >/dev/null 2>"$log.err"; then
      launched=1; break
    fi
    echo "capture.sh: launch attempt $attempt refused: $(tail -1 "$log.err")" >&2
    sleep 3
  done
  rm -f "$log.err"
  [ "$launched" = 1 ] || { echo "capture.sh: app did not launch after 3 attempts" >&2; exit 75; }

  if [ -n "$wait_for" ]; then
    for _ in $(seq 1 60); do
      grep -Eq "$wait_for" "$log" 2>/dev/null && break
      sleep 1
    done
    grep -Eq "$wait_for" "$log" 2>/dev/null || { echo "capture.sh: '$wait_for' not seen in 60 s — see $log" >&2; exit 75; }
    sleep 6
  else
    sleep "$wait_s"
  fi
fi

xcrun simctl io "$udid" screenshot "$out" >/dev/null
echo "$out"
