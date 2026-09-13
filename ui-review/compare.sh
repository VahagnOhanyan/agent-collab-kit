#!/usr/bin/env bash
# Side-by-side comparison sheet for the ui-review workflow.
#
#   tools/ui-review/compare.sh OUT.png LABEL=path.png [LABEL=path.png ...]
#
# Every image is scaled to the same height so a baseline screenshot, AI
# mockups (different pixel sizes) and the post-implementation screenshot line
# up. Labels are drawn under each image. Needs ImageMagick 7 (`magick`).
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 OUT.png LABEL=image.png LABEL=image.png [...]" >&2
  exit 64
fi
command -v magick >/dev/null || { echo "compare.sh: ImageMagick 7 (magick) not found — brew install imagemagick" >&2; exit 69; }

out="$1"; shift
height="${UI_REVIEW_COMPARE_HEIGHT:-1400}"

# ImageMagick has no font registry on a stock Mac — pass a font FILE.
font=""
for candidate in /System/Library/Fonts/SFNS.ttf /System/Library/Fonts/Helvetica.ttc \
                 /System/Library/Fonts/Supplemental/Arial.ttf /Library/Fonts/Arial.ttf; do
  [ -f "$candidate" ] && { font="$candidate"; break; }
done
[ -n "$font" ] || { echo "compare.sh: no usable system font file found" >&2; exit 69; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

i=0
for pair in "$@"; do
  label="${pair%%=*}"
  src="${pair#*=}"
  [ -f "$src" ] || { echo "compare.sh: missing image $src" >&2; exit 66; }
  i=$((i + 1))
  magick "$src" -resize "x${height}" \
    \( -background white -fill '#111111' -font "$font" -pointsize 40 label:"$label" \) \
    -background white -gravity center -append \
    -bordercolor white -border 24 \
    "$tmp/$(printf '%02d' "$i").png"
done

magick "$tmp"/*.png -background '#E9E9EC' -gravity center +append "$out"
echo "$out"
