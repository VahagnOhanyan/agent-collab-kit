#!/usr/bin/env bash
# Deterministic simulator screenshot for the ui-review workflow — generic,
# project-agnostic version. All project parameters (platform, scheme, bundle
# id, product, device) come from the trusted registry, never from this repo:
#
#   collab project --json   ->  { registryDir, projectId, ... }
#   <registryDir>/<projectId>/ui-review.json
#
#   ui-review/capture.sh OUT.png [options]
#     --install                 install the Debug build from DerivedData first
#     --env KEY=VALUE           launch env for the app (repeatable), e.g. APP_DEBUG_OPEN_SCREEN=<id>
#     --appearance dark|light   system appearance (default: dark). The app follows it only if its
#                               OWN in-app appearance setting is "system" — see the project's
#                               ui-review.json "appearanceNote", if any.
#     --wait SECONDS            settle time after launch (default 14)
#     --wait-for REGEX          instead of a fixed wait, poll the app's stdout for this line (timeout 60 s),
#                               then settle 6 s
#     --no-launch               screenshot the current state without relaunching (owner navigated by hand)
#     --dry-run                 resolve and print every parameter (registry project, device, app path,
#                               bundle id, launch env) and exit 0 — nothing is booted, installed or
#                               launched. OUT.png may be omitted with --dry-run.
#
# Only "ios-simulator" is supported here. Any other platform in ui-review.json
# is a clear error: the owner supplies screenshots by hand for that project.
#
# Env:
#   KIT_COLLAB_BIN     path to the collab binary (default: $HOME/.agent-collab-kit/current/bin/collab);
#                      override in tests only.
#   UI_REVIEW_DEVICE   overrides the "device" field from ui-review.json.
#
# Exit codes (sysexits-ish): 64 usage, 65 bad/missing registry data, 66 missing
# input (no project, no ui-review.json, no matching build), 69 collab/tooling
# unavailable, 75 transient failure (simulator refused the launch 3 times).
set -euo pipefail
shopt -s nullglob

self="$0"
usage() { sed -n '2,24p' "$self" >&2; }

out=""
dry_run=0
install=0
launch=1
appearance=dark
wait_s=14
wait_for=""
envs=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) install=1 ;;
    --env) envs+=("SIMCTL_CHILD_$2"); shift ;;
    --appearance) appearance="$2"; shift ;;
    --wait) wait_s="$2"; shift ;;
    --wait-for) wait_for="$2"; shift ;;
    --no-launch) launch=0 ;;
    --dry-run) dry_run=1 ;;
    -*) echo "capture.sh: unknown option $1" >&2; exit 64 ;;
    *)
      if [ -z "$out" ]; then out="$1"; else echo "capture.sh: unexpected argument $1" >&2; exit 64; fi
      ;;
  esac
  shift
done

if [ "$dry_run" = 0 ] && [ -z "$out" ]; then
  usage
  exit 64
fi
if [ -n "$out" ]; then
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
fi

# --- resolve the project from the trusted registry (never from this repo) ---

collab_bin="${KIT_COLLAB_BIN:-$HOME/.agent-collab-kit/current/bin/collab}"
[ -x "$collab_bin" ] || {
  echo "capture.sh: collab binary not found (or not executable) at '$collab_bin' — is agent-collab-kit installed?" >&2
  exit 69
}

if ! project_json="$("$collab_bin" project --json)"; then
  echo "capture.sh: '$collab_bin project --json' failed — is agent-collab-kit installed and collab initialized?" >&2
  exit 69
fi

json_get() {
  # json_get <json-on-stdin-var-not-used> <field>  — reads $project_json, prints "" for null/absent.
  python3 -c '
import json, sys
data = json.loads(sys.argv[1])
value = data.get(sys.argv[2])
print(value if isinstance(value, str) else "")
' "$project_json" "$1"
}

err_msg="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
error = data.get("error")
print(error.get("message", "") if error else "")
' "$project_json")"
if [ -n "$err_msg" ]; then
  echo "capture.sh: collab project --json reported an error: $err_msg" >&2
  exit 66
fi

registry_dir="$(json_get registryDir)"
project_id="$(json_get projectId)"
if [ -z "$project_id" ]; then
  echo "capture.sh: no registry project for this directory (collab project --json → projectId is empty)." >&2
  echo "  run 'collab init' if this repo has no journal yet, then ask the owner to register the" >&2
  echo "  project under \$registryDir/<id>/ (see the ui-review skill for how to draft ui-review.json)." >&2
  exit 66
fi

project_dir="$registry_dir/$project_id"
cfg_file="$project_dir/ui-review.json"
[ -f "$cfg_file" ] || {
  echo "capture.sh: no $cfg_file — the owner has not added a ui-review.json for this project yet." >&2
  echo "  see the ui-review skill: it drafts one by detection and asks the owner to add it to the registry." >&2
  exit 66
}

cfg_field() {
  python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
key = sys.argv[2]
value = data.get(key)
if not isinstance(value, str) or not value:
    sys.exit(3)
print(value)
' "$cfg_file" "$1"
}

require_field() {
  local field="$1" value
  if ! value="$(cfg_field "$field")"; then
    echo "capture.sh: $cfg_file is missing a non-empty string field '$field'" >&2
    exit 65
  fi
  printf '%s' "$value"
}

platform="$(require_field platform)"
xcode_project="$(require_field project)"
scheme="$(require_field scheme)"
bundle="$(require_field bundleId)"
product="$(require_field product)"
device="${UI_REVIEW_DEVICE:-$(require_field device)}"

if [ "$platform" != "ios-simulator" ]; then
  echo "capture.sh: $cfg_file has platform '$platform' — capture.sh only drives ios-simulator." >&2
  echo "  for this project the owner supplies screenshots by hand; the rest of the ui-review flow is unchanged." >&2
  exit 65
fi

# --- newest matching build in DerivedData (not the first glob match: some ---
# --- projects have more than one DerivedData folder for the same scheme)  ---

resolve_app_path() {
  local candidates best="" best_mtime=-1 app mtime
  candidates=("$HOME"/Library/Developer/Xcode/DerivedData/*/Build/Products/Debug-iphonesimulator/"$product".app)
  for app in ${candidates[@]+"${candidates[@]}"}; do
    [ -f "$app/Info.plist" ] || continue
    [ -f "$app/$product" ] || continue
    mtime="$(stat -f %m "$app" 2>/dev/null || echo -1)"
    if [ "$mtime" -gt "$best_mtime" ]; then
      best_mtime="$mtime"
      best="$app"
    fi
  done
  printf '%s' "$best"
}

resolve_udid() {
  xcrun simctl list devices available -j 2>/dev/null | python3 -c "
import json, sys
name = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit
for runtime, devs in data.get('devices', {}).items():
    for d in devs:
        if d.get('name') == name and 'iOS' in runtime:
            print(d['udid']); raise SystemExit
" "$device" || true
}

if [ "$dry_run" = 1 ]; then
  udid="$(resolve_udid)"
  app="$(resolve_app_path)"
  if [ "${#envs[@]}" -gt 0 ]; then
    env_display="${envs[*]}"
  else
    env_display="(none)"
  fi
  cat <<EOF
capture.sh --dry-run
  registry project     : $project_id  ($project_dir)
  platform             : $platform
  xcode project        : $xcode_project
  scheme               : $scheme
  product              : $product
  bundle id            : $bundle
  device name          : $device
  device udid          : ${udid:-<not found among available simulators>}
  app path (DerivedData): ${app:-<no complete Debug-iphonesimulator build found>}
  install requested    : $install
  launch requested     : $launch
  appearance           : $appearance
  launch env           : $env_display
  out                  : ${out:-<none — dry run>}
EOF
  exit 0
fi

udid="$(resolve_udid)"
[ -n "$udid" ] || { echo "capture.sh: no available simulator named '$device'" >&2; exit 69; }

xcrun simctl bootstatus "$udid" -b >/dev/null
open -a Simulator
mkdir -p "$(dirname "$out")"

if [ "$install" = 1 ]; then
  app="$(resolve_app_path)"
  [ -n "$app" ] || { echo "capture.sh: no complete Debug $product.app in DerivedData — build first (see ui-review skill)" >&2; exit 66; }
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
