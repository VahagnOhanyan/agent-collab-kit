#!/usr/bin/env bash
# Codex stages of the ui-review workflow (see .claude/skills/ui-review/SKILL.md).
#
#   tools/ui-review/codex.sh explore  RUN_DIR [VARIANTS]   # render 3-5 visual variants from the baseline
#   tools/ui-review/codex.sh evaluate RUN_DIR              # fresh Codex session scores them and recommends one
#
# RUN_DIR must contain context.md (written by Claude) and baseline*.png (real
# simulator screenshots). Codex runs read-only against the repo; mockups are
# rendered by Codex's native image tool into ~/.codex/generated_images and
# copied into RUN_DIR here, so the run directory is self-contained.
#
# Env: UI_REVIEW_MODEL (default: model from ~/.codex/config.toml),
#      UI_REVIEW_EFFORT (default: high).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
stage="${1:-}"; run="${2:-}"
[ -n "$stage" ] && [ -n "$run" ] || { echo "usage: $0 explore|evaluate RUN_DIR [VARIANTS]" >&2; exit 64; }
run="$(cd "$run" && pwd)"
command -v codex >/dev/null || { echo "codex.sh: codex CLI not found" >&2; exit 69; }
[ -f "$run/context.md" ] || { echo "codex.sh: $run/context.md missing — Claude writes it before Codex runs" >&2; exit 66; }

shopt -s nullglob
baselines=("$run"/baseline*.png)
[ "${#baselines[@]}" -gt 0 ] || { echo "codex.sh: no baseline*.png in $run" >&2; exit 66; }

model_args=()
[ -n "${UI_REVIEW_MODEL:-}" ] && model_args=(-m "$UI_REVIEW_MODEL")
effort="${UI_REVIEW_EFFORT:-high}"

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

prompt="$(python3 - "$template" "$run" "$variants" "$image_list" <<'EOF'
import sys
template, run, variants, images = sys.argv[1:5]
text = open(template).read()
print(text.replace('{{RUN_DIR}}', run).replace('{{VARIANTS}}', variants).replace('{{IMAGES}}', images.rstrip()))
EOF
)"

image_args=()
for img in "${images[@]}"; do image_args+=(-i "$img"); done

echo "codex.sh: $stage → $out (log: $run/$stage.log)"
# The prompt goes BEFORE -i: --image is variadic and would swallow it.
codex exec --skip-git-repo-check -s read-only -C "$repo" \
  ${model_args[@]+"${model_args[@]}"} -c "model_reasoning_effort=\"$effort\"" \
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
