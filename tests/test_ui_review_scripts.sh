#!/usr/bin/env bash
# Tests for the generic ui-review scripts (capture.sh, codex.sh, compare.sh).
#
# Self-contained: builds its own fixtures under tests/.tmp-test-<pid>/ and
# removes them on exit. Never touches a real project, a real simulator, a
# real collab installation, or the real codex CLI — everything is faked.
#
# Run: bash tests/test_ui_review_scripts.sh
set -uo pipefail   # not -e: we want every check to run and be reported

here="$(cd "$(dirname "$0")" && pwd)"
uireview="$(cd "$here/../ui-review" && pwd)"
work="$here/.tmp-test-$$"
mkdir -p "$work"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

pass=0
fail=0
ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { fail=$((fail + 1)); echo "FAIL - $1"; }

echo "== 1. bash -n on every shipped script =="
for script in capture.sh codex.sh compare.sh; do
  if bash -n "$uireview/$script" 2>"$work/synerr-$script.txt"; then
    ok "bash -n $script"
  else
    bad "bash -n $script: $(cat "$work/synerr-$script.txt")"
  fi
done

echo
echo "== 2. capture.sh --dry-run: newest DerivedData build, nothing launched =="

fx="$work/capture-fixture"
old_app="$fx/home/Library/Developer/Xcode/DerivedData/ProjA-old/Build/Products/Debug-iphonesimulator/TestApp.app"
new_app="$fx/home/Library/Developer/Xcode/DerivedData/ProjB-new/Build/Products/Debug-iphonesimulator/TestApp.app"
mkdir -p "$old_app" "$new_app" "$fx/registry/testproj" "$fx/bin"

: >"$old_app/Info.plist"; : >"$old_app/TestApp"
: >"$new_app/Info.plist"; : >"$new_app/TestApp"
# Distinct, deterministic mtimes: the dir's own mtime is what capture.sh compares.
touch -t 202401010000 "$old_app/Info.plist" "$old_app/TestApp" "$old_app"
touch -t 202501010000 "$new_app/Info.plist" "$new_app/TestApp" "$new_app"

cat >"$fx/registry/testproj/ui-review.json" <<'JSON'
{
  "platform": "ios-simulator",
  "project": "TestApp.xcodeproj",
  "scheme": "TestApp",
  "bundleId": "com.example.testapp",
  "product": "TestApp",
  "device": "iPhone 17 Pro Max"
}
JSON

cat >"$fx/bin/collab" <<SH
#!/usr/bin/env bash
if [ "\$1" = "project" ]; then
  cat <<JSON
{"cwd":"$fx","journalRoot":"$fx","codeRoot":"$fx","stateDir":"$fx/.collab","initialized":true,"projectId":"testproj","registryDir":"$fx/registry","configSource":"registry","ignoredEnv":[],"error":null}
JSON
  exit 0
fi
echo "fake collab: unhandled args: \$*" >&2
exit 1
SH
chmod +x "$fx/bin/collab"

cat >"$fx/bin/xcrun" <<SH
#!/usr/bin/env bash
echo "xcrun \$*" >>"$fx/xcrun.log"
case "\$1 \$2" in
  "simctl list")
    cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-1":[{"name":"iPhone 17 Pro Max","udid":"TEST-UDID-0001","isAvailable":true}]}}
JSON
    exit 0
    ;;
  *)
    echo "fake xcrun: forbidden call during --dry-run: \$*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$fx/bin/xcrun"

cat >"$fx/bin/open" <<SH
#!/usr/bin/env bash
echo "open \$*" >>"$fx/open.log"
echo "fake open: should never be called during --dry-run: \$*" >&2
exit 1
SH
chmod +x "$fx/bin/open"

dry_out="$(HOME="$fx/home" PATH="$fx/bin:$PATH" KIT_COLLAB_BIN="$fx/bin/collab" \
  "$uireview/capture.sh" --dry-run 2>"$work/capture-dryrun.err")"
dry_status=$?

if [ "$dry_status" -eq 0 ]; then
  ok "capture.sh --dry-run exits 0"
else
  bad "capture.sh --dry-run exit=$dry_status stderr=$(cat "$work/capture-dryrun.err")"
fi

if echo "$dry_out" | grep -q "ProjB-new"; then
  ok "capture.sh --dry-run picks the NEWEST DerivedData build"
else
  bad "capture.sh --dry-run did not pick the newest build; output:"$'\n'"$dry_out"
fi

if echo "$dry_out" | grep -q "ProjA-old"; then
  bad "capture.sh --dry-run output unexpectedly mentions the OLDER build"
else
  ok "capture.sh --dry-run output does not mention the older build"
fi

if [ -f "$fx/xcrun.log" ] && grep -Eqv "^xcrun simctl list " "$fx/xcrun.log"; then
  bad "capture.sh --dry-run invoked more than 'simctl list': $(cat "$fx/xcrun.log")"
else
  ok "capture.sh --dry-run never calls xcrun boot/install/launch/screenshot"
fi

if [ -f "$fx/open.log" ]; then
  bad "capture.sh --dry-run called 'open' (would boot the Simulator app)"
else
  ok "capture.sh --dry-run never calls 'open -a Simulator'"
fi

echo
echo "== 2b. capture.sh: a non-ios-simulator platform is a clear error, not a crash =="

wfx="$work/capture-fixture-web"
mkdir -p "$wfx/registry/webproj" "$wfx/bin"
cat >"$wfx/registry/webproj/ui-review.json" <<'JSON'
{
  "platform": "web",
  "project": "web-app",
  "scheme": "web",
  "bundleId": "com.example.web",
  "product": "web",
  "device": "n/a"
}
JSON
cat >"$wfx/bin/collab" <<SH
#!/usr/bin/env bash
if [ "\$1" = "project" ]; then
  cat <<JSON
{"cwd":"$wfx","journalRoot":"$wfx","codeRoot":"$wfx","stateDir":"$wfx/.collab","initialized":true,"projectId":"webproj","registryDir":"$wfx/registry","configSource":"registry","ignoredEnv":[],"error":null}
JSON
  exit 0
fi
exit 1
SH
chmod +x "$wfx/bin/collab"

web_err="$(KIT_COLLAB_BIN="$wfx/bin/collab" "$uireview/capture.sh" --dry-run 2>&1 1>/dev/null)"
web_status=$?
if [ "$web_status" -ne 0 ] && echo "$web_err" | grep -qi "only drives ios-simulator"; then
  ok "capture.sh gives a clear error for platform=web and exits non-zero"
else
  bad "capture.sh platform-mismatch handling: status=$web_status err=$web_err"
fi

echo
echo "== 3. codex.sh argument assembly (fake codex records argv) =="

cfx="$work/codex-fixture"
repo="$cfx/repo"
mkdir -p "$repo"
if ! git init -q "$repo" 2>"$work/git-init.err"; then
  bad "git init for the codex.sh fixture repo: $(cat "$work/git-init.err")"
else
  rundir="$repo/.ui-review/testscreen/run1"
  mkdir -p "$rundir" "$cfx/registry/testproj" "$cfx/bin"
  printf '# context\nMUST PRESERVE: nothing special for this test.\n' >"$rundir/context.md"
  : >"$rundir/baseline-default.png"

  printf 'PROJECT-CONTEXT-MARKER-12345\nDesign system: fake, for tests only.\n' \
    >"$cfx/registry/testproj/ui-review.md"

  cat >"$cfx/bin/collab" <<SH
#!/usr/bin/env bash
if [ "\$1" = "project" ]; then
  cat <<JSON
{"cwd":"$cfx","journalRoot":"$cfx","codeRoot":"$repo","stateDir":"$cfx/.collab","initialized":true,"projectId":"testproj","registryDir":"$cfx/registry","configSource":"registry","ignoredEnv":[],"error":null}
JSON
  exit 0
fi
exit 1
SH
  chmod +x "$cfx/bin/collab"

  argv_log="$cfx/codex-argv.log"
  : >"$argv_log"
  cat >"$cfx/bin/codex" <<SH
#!/usr/bin/env bash
# Fake codex: records full argv, then writes minimal valid JSON to the -o path.
{
  printf 'ARGC=%s\n' "\$#"
  i=0
  for a in "\$@"; do i=\$((i + 1)); printf 'ARG[%s]=%s\n' "\$i" "\$a"; done
} >>"$argv_log"
out=""
prev=""
for a in "\$@"; do
  if [ "\$prev" = "-o" ]; then out="\$a"; fi
  prev="\$a"
done
if [ -n "\$out" ]; then
  printf '{"image_tool":"NONE","baseline_problems":[],"variants":[]}' >"\$out"
fi
exit 0
SH
  chmod +x "$cfx/bin/codex"

  (
    cd "$repo" && \
    PATH="$cfx/bin:$PATH" KIT_COLLAB_BIN="$cfx/bin/collab" \
    "$uireview/codex.sh" explore "$rundir" 4 \
      >"$work/codex-stdout.log" 2>"$work/codex-stderr.log"
  )
  codex_status=$?

  if [ "$codex_status" -eq 0 ]; then
    ok "codex.sh explore exits 0 against the fake codex"
  else
    bad "codex.sh explore exit=$codex_status; stderr: $(cat "$work/codex-stderr.log")"
  fi

  if grep -q "PROJECT-CONTEXT-MARKER-12345" "$argv_log" 2>/dev/null; then
    ok "codex.sh substitutes {{PROJECT_CONTEXT}} from the registry's ui-review.md"
  else
    bad "codex.sh did not pass the project's ui-review.md content to codex"
  fi

  if grep -q '{{PROJECT_CONTEXT}}' "$argv_log" 2>/dev/null; then
    bad "codex.sh left the {{PROJECT_CONTEXT}} placeholder unsubstituted"
  else
    ok "no unsubstituted {{PROJECT_CONTEXT}} placeholder reaches codex"
  fi

  if grep -Eq '^ARG\[[0-9]+\]=mcp_servers\.collab\.enabled=false$' "$argv_log" 2>/dev/null; then
    ok "codex.sh passes -c mcp_servers.collab.enabled=false"
  else
    bad "codex.sh did not pass mcp_servers.collab.enabled=false"
  fi

  if grep -Eq '^ARG\[[0-9]+\]=gpt-6-astra$' "$argv_log" 2>/dev/null; then
    ok "codex.sh defaults UI_REVIEW_MODEL to gpt-6-astra"
  else
    bad "codex.sh did not default the model to gpt-6-astra"
  fi

  prompt_line="$(grep -n 'PROJECT-CONTEXT-MARKER-12345' "$argv_log" 2>/dev/null | head -1 | cut -d: -f1)"
  first_i_line="$(grep -nE '^ARG\[[0-9]+\]=-i$' "$argv_log" 2>/dev/null | head -1 | cut -d: -f1)"
  if [ -n "$prompt_line" ] && [ -n "$first_i_line" ] && [ "$prompt_line" -lt "$first_i_line" ]; then
    ok "codex.sh places the prompt BEFORE the first -i (the variadic-flag bug is avoided)"
  else
    bad "codex.sh prompt/-i ordering: prompt_line=$prompt_line first_i_line=$first_i_line"
  fi
fi

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
