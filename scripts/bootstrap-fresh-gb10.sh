#!/usr/bin/env bash
# Bootstrap the core H3 Studio stack on a new ARM64 GB10 host.
#
# This script intentionally installs no host Python or Node.js packages. Docker
# runs every transient downloader and the runtime image supplies ComfyUI,
# Python, PyTorch, and the audited custom nodes. Model files remain host mounts
# outside the image so licences, upgrades, and disk capacity stay explicit.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly H3_MODELSCOPE_MODEL="Comfy-Org/MiniMax-H3"
readonly MUSIC3_MODELSCOPE_MODEL="Comfy-Org/MiniMax-Music-3"
readonly REALESRGAN_SHA256="49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"
readonly RUNTIME_UID=1000
readonly RUNTIME_GID=1000

ENV_FILE="$REPO_DIR/.env.fresh"
SKIP_MODEL_DOWNLOAD=0
PRIVATE_ASSETS_DIR=""
INSTALL_NVIDIA_TOOLKIT=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-fresh-gb10.sh [options]

Options:
  --env FILE                 Deployment environment file (default: .env.fresh)
  --skip-model-download      Do not contact ModelScope/GitHub; validate/start
                             with model files that are already present.
  --private-assets DIR       Copy the authorized FastH3 LoRA and gate from DIR.
  --install-nvidia-container-toolkit
                             Install and configure the NVIDIA Container Toolkit
                             for Docker on Ubuntu/Debian (requires sudo).
  -h, --help                 Show this help.

The environment file must be copied from .env.fresh.example and contains only
paths, image names, and ports. It must not contain a registry token or model
paths with credentials.
EOF
}

log() { printf '[fresh-gb10] %s\n' "$*"; }
die() { printf '[fresh-gb10] ERROR: %s\n' "$*" >&2; exit 1; }

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# This deliberately accepts a small, data-only .env grammar rather than
# sourcing arbitrary shell from a configuration file.
load_environment() {
  local file="$1" raw line key value
  [[ -f "$file" ]] || die "找不到环境配置：$file（可从 .env.fresh.example 复制）。"

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="$(trim "$raw")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:@-]+)$ ]]; then
      die "环境配置只允许 KEY=value 的无空格安全值：$line"
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$file"
}

require_absolute_directory() {
  local name="$1" value="${!1:-}"
  [[ "$value" == /* && "$value" != / && "$value" =~ ^/[A-Za-z0-9_./-]+$ ]] \
    || die "$name 必须是非根目录的绝对 Unix 路径。"
}

require_image_name() {
  local name="$1" value="${!1:-}"
  [[ "$value" =~ ^[A-Za-z0-9./:_-]+$ ]] || die "$name 必须是无空格的镜像引用。"
}

require_port() {
  local name="$1" value="${!1:-}"
  [[ "$value" =~ ^[0-9]{2,5}$ ]] && (( value >= 1 && value <= 65535 )) \
    || die "$name 必须是 1–65535 之间的端口。"
}

validate_environment() {
  require_absolute_directory H3_STUDIO_ROOT
  require_absolute_directory H3_STUDIO_MODELS_DIR
  require_absolute_directory H3_STUDIO_RUNTIME_DIR
  require_absolute_directory H3_STUDIO_DATA_DIR
  require_image_name H3_STUDIO_APP_IMAGE
  require_image_name H3_STUDIO_COMFY_IMAGE
  require_port H3_STUDIO_COMFY_PORT
  require_port H3_STUDIO_APP_PORT
  [[ "$H3_STUDIO_MODELS_DIR" != "$H3_STUDIO_ROOT" && "$H3_STUDIO_RUNTIME_DIR" != "$H3_STUDIO_ROOT" ]] \
    || die '模型和运行时目录不能直接等于 H3_STUDIO_ROOT。'
}

as_root() {
  if (( EUID == 0 )); then
    "$@"
  else
    command -v sudo >/dev/null || die '安装 NVIDIA Container Toolkit 需要 root 或 sudo。'
    sudo "$@"
  fi
}

install_nvidia_container_toolkit() {
  command -v apt-get >/dev/null || die '自动安装仅支持 Ubuntu/Debian 的 apt 主机。请按 NVIDIA 官方文档手动配置。'

  log '按 NVIDIA 官方仓库配置 NVIDIA Container Toolkit，并重启 Docker。'
  as_root apt-get update
  as_root apt-get install -y --no-install-recommends ca-certificates curl gnupg2
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | as_root gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | as_root tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  as_root apt-get update
  as_root apt-get install -y nvidia-container-toolkit
  as_root nvidia-ctk runtime configure --runtime=docker
  as_root systemctl restart docker
}

ensure_docker_gpu() {
  command -v docker >/dev/null || die '未找到 Docker。请先安装 Docker Engine 与 Docker Compose v2。'
  docker compose version >/dev/null || die '未找到 Docker Compose v2（docker compose）。'
  command -v nvidia-smi >/dev/null || die '未找到 nvidia-smi；请先安装 GB10 驱动。'
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader

  log '拉取应用和 ComfyUI 运行时镜像。私有 GHCR 包需要先执行 docker login ghcr.io。'
  docker pull "$H3_STUDIO_COMFY_IMAGE"
  docker pull "$H3_STUDIO_APP_IMAGE"

  log '验证 Docker 可以取得 NVIDIA GPU。'
  if ! docker run --rm --gpus all --entrypoint nvidia-smi "$H3_STUDIO_COMFY_IMAGE" \
    --query-gpu=name,driver_version --format=csv,noheader; then
    die 'Docker 尚不能访问 GPU。请先安装/配置 NVIDIA Container Toolkit，或重试时加入 --install-nvidia-container-toolkit。'
  fi
}

prepare_directories() {
  install -d -m 0750 \
    "$H3_STUDIO_ROOT" \
    "$H3_STUDIO_MODELS_DIR" \
    "$H3_STUDIO_RUNTIME_DIR" \
    "$H3_STUDIO_DATA_DIR/input" \
    "$H3_STUDIO_DATA_DIR/output" \
    "$H3_STUDIO_RUNTIME_DIR/realesrgan-models" \
    "$H3_STUDIO_RUNTIME_DIR/realesrgan-state" \
    "$H3_STUDIO_RUNTIME_DIR/realesrgan-work" \
    "$H3_STUDIO_RUNTIME_DIR/flashvsr-state"
  # The published runtime and the Node application both use uid/gid 1000.
  # A privileged one-shot container adjusts only H3 Studio's host data; model
  # weights stay owned by their download user and are mounted read-only.
  docker run --rm --user 0 --entrypoint chown \
    -v "$H3_STUDIO_DATA_DIR:/h3-data" \
    -v "$H3_STUDIO_RUNTIME_DIR:/h3-runtime" \
    "$H3_STUDIO_COMFY_IMAGE" \
    -R "$RUNTIME_UID:$RUNTIME_GID" /h3-data /h3-runtime
}

extract_runtime_venv() {
  local venv_dir="$H3_STUDIO_RUNTIME_DIR/venv" container_id stage_dir
  if [[ -x "$venv_dir/bin/python" ]]; then
    log '复用已提取的 GB10 Python 虚拟环境。'
    return
  fi
  [[ ! -e "$venv_dir" ]] || die "运行时 venv 路径存在但不是有效环境：$venv_dir"

  log '从已验证的 ComfyUI 运行时镜像提取只供 worker 使用的 Python 环境。'
  container_id="$(docker create "$H3_STUDIO_COMFY_IMAGE")"
  stage_dir="$(mktemp -d "$H3_STUDIO_RUNTIME_DIR/.venv-stage.XXXXXX")"
  cleanup_venv_stage() {
    docker rm -f "$container_id" >/dev/null 2>&1 || true
    [[ -d "$stage_dir" ]] && rm -rf -- "$stage_dir"
  }
  trap cleanup_venv_stage RETURN
  docker cp "$container_id:/comfy/mnt/venv/." "$stage_dir/"
  [[ -x "$stage_dir/bin/python" ]] || die '运行时镜像中没有预期的 /comfy/mnt/venv/bin/python。'
  mv -- "$stage_dir" "$venv_dir"
  stage_dir=''
  docker rm -f "$container_id" >/dev/null
  container_id=''
  trap - RETURN
}

run_modelscope_download() {
  local model="$1"
  shift
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
    -v "$H3_STUDIO_MODELS_DIR:/models" \
    python:3.12-slim \
    sh -ceu '
      model="$1"
      shift
      python -m pip install --no-cache-dir "modelscope>=1.25,<2"
      modelscope download --model "$model" --local_dir /models --include "$@"
    ' sh "$model" "$@"
}

download_core_models() {
  local h3_required=(
    diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
    diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors
    text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
    vae/minimax_h3_video_vae_fp16.safetensors
    vae/minimax_h3_audio_vae_fp32.safetensors
    loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
  )
  local music_required=(
    diffusion_models/minimax_music3_dit_fp16.safetensors
    text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors
    vae/minimax_music3_dav.safetensors
  )
  local relative

  for relative in "${h3_required[@]}" "${music_required[@]}"; do
    [[ -s "$H3_STUDIO_MODELS_DIR/$relative" ]] || break
  done
  if [[ "${relative:-}" != "${music_required[-1]}" || ! -s "$H3_STUDIO_MODELS_DIR/${music_required[-1]}" ]]; then
    log '从魔搭下载 H3、参考模式、Turbo 与 Music3 的核心权重（可断点重跑）。'
    run_modelscope_download "$H3_MODELSCOPE_MODEL" "${h3_required[@]}"
    run_modelscope_download "$MUSIC3_MODELSCOPE_MODEL" "${music_required[@]}"
  else
    log '核心 H3 与 Music3 权重已存在，跳过下载。'
  fi
}

download_atomic() {
  local destination_dir="$1" filename="$2" url="$3"
  local destination="$destination_dir/$filename" temporary="$destination_dir/.${filename}.part"
  [[ -s "$destination" ]] && return
  install -d -m 0750 "$destination_dir"
  rm -f -- "$temporary"
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$destination_dir:/output" \
    curlimages/curl:8.12.1 \
    -fL --retry 5 --retry-all-errors --connect-timeout 20 --max-time 3600 \
    -o "/output/.${filename}.part" "$url"
  [[ -s "$temporary" ]] || die "下载失败或文件为空：$filename"
  mv -- "$temporary" "$destination"
}

download_auxiliary_models() {
  local realesrgan_dir="$H3_STUDIO_RUNTIME_DIR/realesrgan-models"
  local realesrgan_path="$realesrgan_dir/RealESRGAN_x2plus.pth"

  download_atomic "$H3_STUDIO_MODELS_DIR/vae_approx" taeh3_decoder.safetensors \
    'https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride/raw/main/minivae/taeh3_decoder.safetensors'

  if [[ -f "$realesrgan_path" ]] \
    && [[ "$(sha256sum "$realesrgan_path" | awk '{print $1}')" != "$REALESRGAN_SHA256" ]]; then
    local rejected="$realesrgan_path.invalid.$(date +%Y%m%d%H%M%S)"
    log "已有 RealESRGAN 文件校验失败，已保留为 $rejected。"
    mv -- "$realesrgan_path" "$rejected"
  fi
  download_atomic "$realesrgan_dir" RealESRGAN_x2plus.pth \
    'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth'
  [[ "$(sha256sum "$realesrgan_path" | awk '{print $1}')" == "$REALESRGAN_SHA256" ]] \
    || die 'RealESRGAN_x2plus.pth SHA-256 校验失败。'
}

install_private_fasth3_assets() {
  [[ -n "$PRIVATE_ASSETS_DIR" ]] || return
  [[ -d "$PRIVATE_ASSETS_DIR" ]] || die "FastH3 授权包目录不存在：$PRIVATE_ASSETS_DIR"
  local filename destination
  for filename in fasth3_vsa_4-steps-v5.safetensors fasth3_vsa_gate.safetensors; do
    [[ -f "$PRIVATE_ASSETS_DIR/$filename" ]] \
      || die "授权 FastH3 包缺少：$filename"
    destination="$H3_STUDIO_MODELS_DIR/loras/$filename"
    install -d -m 0750 "$H3_STUDIO_MODELS_DIR/loras"
    install -m 0640 "$PRIVATE_ASSETS_DIR/$filename" "$destination"
  done
  log '已安装授权 FastH3 LoRA 与 gate；不会把它们纳入容器镜像。'
}

ensure_model_layout() {
  local required=(
    diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
    diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors
    text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
    vae/minimax_h3_video_vae_fp16.safetensors
    vae/minimax_h3_audio_vae_fp32.safetensors
    loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors
    diffusion_models/minimax_music3_dit_fp16.safetensors
    text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors
    vae/minimax_music3_dav.safetensors
    vae_approx/taeh3_decoder.safetensors
  )
  local relative
  for relative in "${required[@]}"; do
    [[ -s "$H3_STUDIO_MODELS_DIR/$relative" ]] \
      || die "缺少核心模型文件：$H3_STUDIO_MODELS_DIR/$relative"
  done
}

start_core_stack() {
  log '构建 RealESRGAN sidecar 并启动 ComfyUI、H3 Studio。'
  docker compose --env-file "$ENV_FILE" -f "$REPO_DIR/docker-compose.fresh-gb10.yml" pull comfyui h3-studio
  docker compose --env-file "$ENV_FILE" -f "$REPO_DIR/docker-compose.fresh-gb10.yml" \
    up -d --build comfyui realesrgan-worker h3-studio
}

while (( $# > 0 )); do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || die '--env 需要一个文件路径。'
      ENV_FILE="$2"
      shift 2
      ;;
    --skip-model-download)
      SKIP_MODEL_DOWNLOAD=1
      shift
      ;;
    --private-assets)
      [[ $# -ge 2 ]] || die '--private-assets 需要一个目录。'
      PRIVATE_ASSETS_DIR="$2"
      shift 2
      ;;
    --install-nvidia-container-toolkit)
      INSTALL_NVIDIA_TOOLKIT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

ENV_FILE="$(cd -- "$(dirname -- "$ENV_FILE")" && pwd)/$(basename -- "$ENV_FILE")"
load_environment "$ENV_FILE"
validate_environment
if (( INSTALL_NVIDIA_TOOLKIT == 1 )); then
  install_nvidia_container_toolkit
fi
ensure_docker_gpu
prepare_directories
extract_runtime_venv
if (( SKIP_MODEL_DOWNLOAD == 0 )); then
  download_core_models
  download_auxiliary_models
fi
install_private_fasth3_assets
ensure_model_layout
start_core_stack
"$SCRIPT_DIR/verify-fresh-gb10.sh" --env "$ENV_FILE"
log "部署完成：H3 Studio http://127.0.0.1:$H3_STUDIO_APP_PORT"
