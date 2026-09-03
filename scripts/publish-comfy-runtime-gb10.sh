#!/usr/bin/env bash
# Create a portable GB10 ComfyUI runtime image from a known-good host checkout.
# The script stages only code and the virtual environment, then rejects model
# weights and configuration/secrets before Docker is allowed to build or push.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SOURCE_DIR=""
IMAGE="ghcr.io/xiaofei-fei/h3-studio-gb10/comfy-runtime:gb10-v1"
BASE_IMAGE="comfyui-gb10:v2"
PUSH_IMAGE=1
BUILD_NETWORK=default

usage() {
  cat <<'EOF'
Usage: scripts/publish-comfy-runtime-gb10.sh --source DIR [options]

Options:
  --source DIR       Existing GB10 runtime root containing ComfyUI/ and venv/.
  --image IMAGE      GHCR tag to build (default: .../comfy-runtime:gb10-v1).
  --base-image IMG   Existing GB10 base image (default: comfyui-gb10:v2).
  --build-network N  Docker build network: default or host (default: default).
  --no-push          Build and inspect locally, but do not publish.
  -h, --help         Show this help.

The source directory is copied into a temporary sanitized build context. Model
weights, inputs, outputs, .env files, Git history, and secret-like filenames
are excluded and then checked again. Never point --source at a broad home
directory.
EOF
}

log() { printf '[publish-comfy-runtime] %s\n' "$*"; }
die() { printf '[publish-comfy-runtime] ERROR: %s\n' "$*" >&2; exit 1; }

validate_source() {
  [[ -n "$SOURCE_DIR" ]] || die '--source 是必填参数。'
  [[ "$SOURCE_DIR" == /* && "$SOURCE_DIR" != / && "$SOURCE_DIR" =~ ^/[A-Za-z0-9_./-]+$ ]] \
    || die '--source 必须是非根目录的绝对 Unix 路径。'
  [[ -d "$SOURCE_DIR/ComfyUI" ]] || die "缺少 $SOURCE_DIR/ComfyUI"
  [[ -x "$SOURCE_DIR/venv/bin/python" ]] || die "缺少 $SOURCE_DIR/venv/bin/python"
  [[ "$IMAGE" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]] \
    || die '--image 必须是带 tag 的安全镜像引用。'
  if (( PUSH_IMAGE == 1 )); then
    [[ "$IMAGE" =~ ^ghcr\.io/[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]] \
      || die '未使用 --no-push 时，--image 必须是带 tag 的 ghcr.io 镜像引用。'
  fi
  [[ "$BASE_IMAGE" =~ ^[A-Za-z0-9./:_-]+$ ]] || die '--base-image 不是安全的镜像引用。'
  [[ "$BUILD_NETWORK" == default || "$BUILD_NETWORK" == host ]] \
    || die '--build-network 只支持 default 或 host。'
}

contains_forbidden_file() {
  local stage="$1" pattern="$2" found
  found="$(find "$stage" -type f -name "$pattern" -print -quit)"
  if [[ -n "$found" ]]; then
    die "已拒绝构建：发现不应进入运行时镜像的文件 $found"
  fi
}

reject_sensitive_material() {
  local stage="$1" found
  # A Python venv legitimately contains tiny ``*.pth`` path files. Model-like
  # files are never valid in ComfyUI source, so reject them there and reject
  # suspiciously large .pth files anywhere in the staged venv.
  contains_forbidden_file "$stage/ComfyUI" '*.safetensors'
  contains_forbidden_file "$stage/ComfyUI" '*.ckpt'
  contains_forbidden_file "$stage/ComfyUI" '*.pth'
  contains_forbidden_file "$stage/ComfyUI" '*.pt'
  contains_forbidden_file "$stage/ComfyUI" '*.onnx'
  found="$(find "$stage/venv" -type f -name '*.pth' -size +32M -print -quit)"
  [[ -z "$found" ]] || die "已拒绝构建：venv 中发现异常大的 .pth 文件 $found"
  found="$(find "$stage/ComfyUI" -type f \( -name '.env' -o -name '.env.*' -o -name '*credential*' -o -name '*secret*' \) -print -quit)"
  [[ -z "$found" ]] || die "已拒绝构建：发现配置或敏感文件 $found"
  [[ ! -e "$stage/ComfyUI/models" ]] || die '已拒绝构建：ComfyUI/models 不应进入运行时镜像。'
}

stage_runtime() {
  local stage="$1"
  # tar preserves symlinks, permissions and Python package metadata while the
  # explicit exclusions stop common live data from ever entering the context.
  # ComfyUI may update a directory mtime while its long-running process is
  # serving requests.  Suppress only GNU tar's non-content "file changed"
  # warning; real read failures still stop this pipe because of ``pipefail``.
  tar --warning=no-file-changed -C "$SOURCE_DIR" \
    --exclude='ComfyUI/.git' \
    --exclude='ComfyUI/.git/*' \
    --exclude='ComfyUI/.env' \
    --exclude='ComfyUI/.env.*' \
    --exclude='ComfyUI/models' \
    --exclude='ComfyUI/models/*' \
    --exclude='ComfyUI/input' \
    --exclude='ComfyUI/input/*' \
    --exclude='ComfyUI/output' \
    --exclude='ComfyUI/output/*' \
    --exclude='ComfyUI/temp' \
    --exclude='ComfyUI/temp/*' \
    --exclude='ComfyUI/user' \
    --exclude='ComfyUI/user/*' \
    --exclude='ComfyUI/custom_nodes/*/.git' \
    --exclude='ComfyUI/custom_nodes/*/.git/*' \
    --exclude='ComfyUI/**/__pycache__' \
    --exclude='ComfyUI/**/__pycache__/*' \
    -cf - ComfyUI venv | tar -C "$stage" -xf -

  install -d -m 0755 "$stage/docker"
  install -m 0755 "$REPO_DIR/docker/comfy-runtime-entrypoint.sh" \
    "$stage/docker/comfy-runtime-entrypoint.sh"

}

while (( $# > 0 )); do
  case "$1" in
    --source)
      [[ $# -ge 2 ]] || die '--source 需要一个目录。'
      SOURCE_DIR="$2"
      shift 2
      ;;
    --image)
      [[ $# -ge 2 ]] || die '--image 需要一个镜像引用。'
      IMAGE="$2"
      shift 2
      ;;
    --base-image)
      [[ $# -ge 2 ]] || die '--base-image 需要一个镜像引用。'
      BASE_IMAGE="$2"
      shift 2
      ;;
    --build-network)
      [[ $# -ge 2 ]] || die '--build-network 需要 default 或 host。'
      BUILD_NETWORK="$2"
      shift 2
      ;;
    --no-push)
      PUSH_IMAGE=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

validate_source
command -v docker >/dev/null || die '未找到 Docker。'
docker image inspect "$BASE_IMAGE" >/dev/null \
  || die "本地没有基础镜像：$BASE_IMAGE"

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/h3-studio-comfy-runtime.XXXXXX")"
cleanup_stage() { rm -rf -- "$stage_dir"; }
trap cleanup_stage EXIT

log "从 $SOURCE_DIR 创建经过审计的临时构建上下文。"
stage_runtime "$stage_dir"
reject_sensitive_material "$stage_dir"
comfy_commit="$(git -C "$SOURCE_DIR/ComfyUI" rev-parse HEAD 2>/dev/null || printf unknown)"

docker build \
  --network "$BUILD_NETWORK" \
  --file "$REPO_DIR/Dockerfile.comfy-runtime" \
  --build-arg "COMFYUI_BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "COMFYUI_COMMIT=$comfy_commit" \
  --tag "$IMAGE" \
  "$stage_dir"

if (( PUSH_IMAGE == 1 )); then
  log "推送已审计的 GB10 运行时镜像：$IMAGE"
  docker push "$IMAGE"
else
  log "本地镜像构建完成（--no-push）：$IMAGE"
fi
