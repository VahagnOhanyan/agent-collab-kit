#!/usr/bin/env bash
# Codex stages of the ui-review workflow (see skills/ui-review/SKILL.md) —
# generic, project-agnostic version.
#
#   ui-review/codex.sh explore  RUN_DIR [VARIANTS]   # render 3-5 visual variants from the baseline
#   ui-review/codex.sh evaluate RUN_DIR              # fresh Codex session scores them and recommends one
#
# RUN_DIR must contain context.md (written by Claude) and baseline*.png (real
# device/simulator screenshots, or screenshots the owner supplied by hand).
# Codex runs read-only against the repo; mockups are rendered by Codex's
# native image tool into ~/.codex/generated_images and copied into RUN_DIR
# here, so the run directory is self-contained.
#
# Repo root is `git -C "$PWD" rev-parse --show-toplevel` — the CALLER's
# working tree, not wherever this script physically lives (it may be invoked
# from a shared kit location outside any one project checkout).
#
# {{PROJECT_CONTEXT}} in the prompt templates is filled from
# <registryDir>/<projectId>/ui-review.md (via `collab project --json`), if
# that file exists; otherwise a short placeholder is used.
#
# `-c mcp_servers.collab.enabled=false` is always passed to `codex exec` so a
# design/rendering run can never read or write this project's collab journal.
#
# Env:
#   KIT_COLLAB_BIN     path to the collab binary (default: $HOME/.agent-collab-kit/current/bin/collab);
#                      override in tests only.
#   UI_REVIEW_MODEL    default: gpt-6-astra (rendering needs it). This is a paid, non-default
#                       model — the ui-review SKILL states its cost and waits for the owner's
#                       consent before every run; do not call this script without that.
#                       It is the L3 rung for this vendor (`collab models` is the ladder), chosen
#                       here because generating images needs it — never as a review default.
#   UI_REVIEW_EFFORT   default: high.
set -euo pipefail
shopt -s nullglob

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$PWD" rev-parse --show-toplevel)"
stage="${1:-}"; run="${2:-}"
[ -n "$stage" ] && [ -n "$run" ] || { echo "usage: $0 explore|evaluate RUN_DIR [VARIANTS]" >&2; exit 64; }
run="$(cd "$run" && pwd)"
command -v codex >/dev/null || { echo "codex.sh: codex CLI not found" >&2; exit 69; }
[ -f "$run/context.md" ] || { echo "codex.sh: $run/context.md missing — Claude writes it before Codex runs" >&2; exit 66; }

shopt -s nullglob
baselines=("$run"/baseline*.png)
[ "${#baselines[@]}" -gt 0 ] || { echo "codex.sh: no baseline*.png in $run" >&2; exit 66; }

model="${UI_REVIEW_MODEL:-gpt-6-astra}"
effort="${UI_REVIEW_EFFORT:-high}"
echo "codex.sh: model=$model effort=$effort (default model is gpt-6-astra — confirm cost with the owner per the ui-review skill)" >&2

# --- project context (best-effort: a project without ui-review.md still works) ---

collab_bin="${KIT_COLLAB_BIN:-$HOME/.agent-collab-kit/current/bin/collab}"
project_context_file="$run/.project-context.md"
project_context_found=0
if [ -x "$collab_bin" ] && project_json="$("$collab_bin" project --json 2>/dev/null)"; then
  registry_dir="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
value = data.get("registryDir")
print(value if isinstance(value, str) else "")
' "$project_json" 2>/dev/null || true)"
  project_id="$(python3 -c '
import json, sys
data = json.loads(sys.argv[1])
value = data.get("projectId")
print(value if isinstance(value, str) else "")
' "$project_json" 2>/dev/null || true)"
  if [ -n "$registry_dir" ] && [ -n "$project_id" ] && [ -f "$registry_dir/$project_id/ui-review.md" ]; then
    cp "$registry_dir/$project_id/ui-review.md" "$project_context_file"
    project_context_found=1
  fi
fi
if [ "$project_context_found" = 0 ]; then
  echo "codex.sh: no ui-review.md found in the registry for this project — using an empty project context" >&2
  printf '%s\n' "(no project-specific context was registered for this project — product, design system and confirmed decisions are unknown here; rely on context.md and be conservative about design-system claims.)" >"$project_context_file"
fi

case "$stage" in
  explore)
    variants="${3:-4}"
    images=("${baselines[@]}")
    schema="$here/explore.schema.json"; template="$here/explore.prompt.md"; out="$run/explore.json"
    ;;
  evaluate)
    [ -f "$run/explore.json" ] || { echo "codex.sh: run explore first" >&2; exit 66; }
    variant_images=("$run"/variant-*.png)
    [ "${#variant_images[@]}" -gt 0 ] || { echo "codex.sh: no variant-*.png in $run" >&2; exit 66; }
    variants=""
    images=("${baselines[@]}" "${variant_images[@]}")
    schema="$here/evaluate.schema.json"; template="$here/evaluate.prompt.md"; out="$run/evaluate.json"
    ;;
  *) echo "codex.sh: unknown stage $stage" >&2; exit 64 ;;
esac

image_list=""
for img in "${images[@]}"; do image_list+="- $img"$'\n'; done

prompt="$(python3 - "$template" "$run" "$variants" "$image_list" "$project_context_file" <<'EOF'
import sys
template, run, variants, images, context_file = sys.argv[1:6]
text = open(template, encoding='utf-8').read()
context = open(context_file, encoding='utf-8').read()
text = (text.replace('{{RUN_DIR}}', run)
            .replace('{{VARIANTS}}', variants)
            .replace('{{IMAGES}}', images.rstrip())
            .replace('{{PROJECT_CONTEXT}}', context.rstrip()))
print(text)
EOF
)"

image_args=()
for img in "${images[@]}"; do image_args+=(-i "$img"); done

echo "codex.sh: $stage → $out (log: $run/$stage.log)"
# The prompt goes BEFORE -i: --image is variadic and would swallow it.
codex exec --skip-git-repo-check -s read-only -C "$repo" \
  -m "$model" -c "model_reasoning_effort=\"$effort\"" \
  -c "mcp_servers.collab.enabled=false" \
  --output-schema "$schema" -o "$out" \
  "$prompt" "${image_args[@]}" \
  </dev/null >"$run/$stage.log" 2>&1

python3 - "$stage" "$run" "$out" <<'EOF'
import json, shutil, sys, os
stage, run, out = sys.argv[1:4]
data = json.load(open(out))
def take(src, name):
    if src and os.path.isfile(src):
        dst = os.path.join(run, name)
        shutil.copyfile(src, dst)
        return dst
    return ''
if stage == 'explore':
    for v in data['variants']:
        v['local_image'] = take(v.get('image_path'), f"variant-{v['id']}.png")
        print(f"variant {v['id']}: {v['name']} → {v['local_image'] or 'NO IMAGE'}")
    print('image tool:', data.get('image_tool'))
else:
    rec = data['recommendation']
    rec['local_hybrid_image'] = take(rec.get('hybrid_image_path'), 'hybrid.png')
    print('recommended base:', rec['base_variant_id'], '| borrow:', rec['borrow_from_others'], '| hybrid image:', rec['local_hybrid_image'] or 'none')
json.dump(data, open(out, 'w'), ensure_ascii=False, indent=2)
EOF
