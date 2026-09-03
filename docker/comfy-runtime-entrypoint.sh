#!/usr/bin/env bash
# Start the sealed GB10 runtime directly. The NVIDIA base entrypoint is an
# installer that mutates ComfyUI and contacts package indexes; those operations
# are deliberately excluded from a reproducible, published inference runtime.

set -Eeuo pipefail

if (( $# > 0 )); then
  exec "$@"
fi

cd /comfy/mnt/ComfyUI
readonly cmdline_extra="${COMFY_CMDLINE_EXTRA:---models-directory /models/minimax-h3 --vram-headroom 8 --preview-method none --enable-manager --use-sage-attention}"
read -r -a extra_args <<< "$cmdline_extra"

exec /comfy/mnt/venv/bin/python ./main.py \
  --listen 0.0.0.0 \
  --port 8188 \
  --disable-auto-launch \
  "${extra_args[@]}"
