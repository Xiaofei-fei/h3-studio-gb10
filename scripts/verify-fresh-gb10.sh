#!/usr/bin/env bash
# Validate the core fresh-host stack without attempting a costly generation.

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.fresh"

usage() {
  printf '%s\n' 'Usage: scripts/verify-fresh-gb10.sh [--env FILE]'
}

log() { printf '[verify-fresh-gb10] %s\n' "$*"; }
die() { printf '[verify-fresh-gb10] ERROR: %s\n' "$*" >&2; exit 1; }

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

load_environment() {
  local file="$1" raw line key value
  [[ -f "$file" ]] || die "找不到环境配置：$file"
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="$(trim "$raw")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:@-]+)$ ]] \
      || die "环境配置格式不安全：$line"
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    printf -v "$key" '%s' "$value"
    export "$key"
  done < "$file"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$REPO_DIR/docker-compose.fresh-gb10.yml" "$@"
}

# Use the already-published Node application as a tiny internal HTTP client.
# This keeps a model-preloaded/offline install self-contained: the verifier no
# longer pulls a disposable curl image from Docker Hub just to contact local
# services. The application is attached to the same bridge network as ComfyUI.
request_from_app() {
  local url="$1"
  compose exec -T h3-studio node -e '
    const url = process.argv[1];
    fetch(url)
      .then(async (response) => {
        const body = await response.text();
        if (!response.ok) {
          process.stderr.write(body);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(body);
      })
      .catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
      });
  ' "$url"
}

request() {
  request_from_app "http://comfyui:8188$1"
}

request_app() {
  request_from_app 'http://127.0.0.1:5174/api/health'
}

expect_contains() {
  local value="$1" needle="$2" label="$3"
  [[ "$value" == *"$needle"* ]] || die "$label 缺少：$needle"
}

wait_for_comfy() {
  local attempt response
  for attempt in $(seq 1 60); do
    response="$(request /system_stats 2>/dev/null || true)"
    [[ -n "$response" ]] && { printf '%s' "$response"; return; }
    sleep 2
  done
  compose logs --tail=120 comfyui >&2 || true
  die 'ComfyUI 在 120 秒内未就绪。'
}

wait_for_app() {
  local attempt response
  for attempt in $(seq 1 45); do
    response="$(request_app 2>/dev/null || true)"
    [[ -n "$response" ]] && { printf '%s' "$response"; return; }
    sleep 2
  done
  compose logs --tail=120 h3-studio >&2 || true
  die 'H3 Studio 在 90 秒内未就绪。'
}

while (( $# > 0 )); do
  case "$1" in
    --env)
      [[ $# -ge 2 ]] || die '--env 需要一个文件路径。'
      ENV_FILE="$2"
      shift 2
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
command -v docker >/dev/null || die '未找到 Docker。'
compose ps

system_stats="$(wait_for_comfy)"
object_info="$(request /object_info)"
health="$(wait_for_app)"

expect_contains "$system_stats" '"system"' 'ComfyUI system_stats'
expect_contains "$object_info" '"MiniMaxH3ReferenceToVideo"' 'H3 参考节点'
expect_contains "$object_info" '"MiniMaxMusic3TextEncode"' 'Music3 节点'
expect_contains "$object_info" '"H3StudioTAEH3PreviewLoader"' 'TAEH3 预览节点'
expect_contains "$object_info" '"H3SpargeAttention"' 'SpargeAttention 节点'
expect_contains "$object_info" '"MiniMaxH3VAEDecodeBatched"' 'VAE Tile Batch 节点'
expect_contains "$object_info" 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' 'H3 Standard 权重'
expect_contains "$object_info" 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' 'H3 参考权重'
expect_contains "$object_info" 'minimax_music3_dit_fp16.safetensors' 'Music3 权重'
expect_contains "$object_info" 'taeh3_decoder.safetensors' 'TAEH3 权重'
expect_contains "$health" '"connected":true' 'H3 Studio 到 ComfyUI 的连接'
expect_contains "$health" '"h3References":{"available":true' 'H3 参考能力'
expect_contains "$health" '"music3":{"available":true' 'Music3 能力'
expect_contains "$health" '"taeH3Preview":{"available":true' 'TAEH3 预览能力'
expect_contains "$health" '"deterministicUpscale":{"available":true' 'RealESRGAN 增强能力'

log '核心服务、模型文件、H3 参考、Music3、TAEH3、Sparge 和 RealESRGAN 均已通过结构验收。'
