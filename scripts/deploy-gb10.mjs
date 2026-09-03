import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDES = [
  'node_modules',
  '.git',
  '.secrets',
  '.env',
  '.env.*',
  '.cloudflared.env',
  '.playwright-cli',
  '.pytest_cache',
  '__pycache__',
  'models',
  'model-staging',
  'outputs',
  'input',
  'flashvsr-venv',
  'flashvsr-wheelhouse',
  'flashvsr-sources',
  'flashvsr-state',
  'flashvsr-work',
  'realesrgan-models',
  'realesrgan-state',
  'realesrgan-work',
  'cloudflare-worker/wrangler.jsonc',
  'cloudflare-worker/.wrangler',
];
const DEFAULT_GB10_HOST = 'gb10';
const DEFAULT_GB10_DIR = '/home/lenovo/yuxf8/h3-studio';
const DEFAULT_COMFY_CONTAINER = 'yuxf8_h3';
const DEFAULT_COMFY_CUSTOM_NODES_DIR = '/comfy/mnt/ComfyUI/custom_nodes';
const DEFAULT_COMFY_OUTPUT_DIR = '/home/lenovo/yuxf8/comfy-data/mnt/ComfyUI/output';
const DEFAULT_COMFY_VENV_DIR = '/home/lenovo/yuxf8/comfy-data/mnt/venv';
const DEFAULT_FLASHVSR_MODEL_DIR = '/home/lenovo/yuxf8/model/flashvsr';
const TAEH3_PREVIEW_NODE_SOURCE = 'comfy_nodes/h3_studio_taeh3_preview/.';
const REALESRGAN_MODEL_FILENAME = 'RealESRGAN_x2plus.pth';
const REALESRGAN_MODEL_SHA256 = '49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb';

export function parsePortableEnvironment(source) {
  const entries = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^#\s]+)$/);
    if (!match) continue;
    entries[match[1]] = match[2];
  }
  return entries;
}

function loadPortableEnvironment(envFilePath, environment = process.env) {
  if (!existsSync(envFilePath)) return false;
  const entries = parsePortableEnvironment(readFileSync(envFilePath, 'utf8'));
  for (const [key, value] of Object.entries(entries)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return true;
}

function loadCliEnvironment() {
  const envFileIndex = process.argv.indexOf('--h3-env-file');
  const isExplicit = envFileIndex !== -1;
  const envFileArgument = isExplicit ? process.argv[envFileIndex + 1] : '.env';
  if (!envFileArgument) throw new Error('--h3-env-file 需要一个文件路径。');
  const envFilePath = resolve(process.cwd(), envFileArgument);
  if (!loadPortableEnvironment(envFilePath) && isExplicit) {
    throw new Error(`找不到指定的环境配置文件：${envFilePath}`);
  }
}

function validateHost(host) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(host)) {
    throw new Error('H3_STUDIO_GB10_HOST 必须是 SSH 主机别名或主机名。');
  }
  return host;
}

function validateDirectory(value, name) {
  if (!value.startsWith('/') || !/^[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error(`${name} 必须是绝对 Unix 路径，且不能包含空格或 shell 字符。`);
  }
  const normalized = value.replace(/\/+$/, '');
  if (!normalized) throw new Error(`${name} 不能是文件系统根目录。`);
  return normalized;
}

function validateContainerName(value, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`${name} 必须是 Docker 容器名，且不能包含空格或 shell 字符。`);
  }
  return value;
}

function withTrailingSlash(value) {
  return `${value.replace(/\/+$/, '')}/`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readTaeH3PreviewNodeVersion(sourceDir) {
  const loaderPath = resolve(sourceDir, 'comfy_nodes/h3_studio_taeh3_preview/loader.py');
  const source = readFileSync(loaderPath, 'utf8');
  const match = source.match(/^NODE_VERSION = "([A-Za-z0-9._-]+)"$/m);
  if (!match) throw new Error('TAEH3 预览节点缺少受支持的 NODE_VERSION 标记。');
  return match[1];
}

function previewNodeHealthCheckCommand() {
  return [
    'attempt=1',
    'while [ "$attempt" -le 30 ]; do',
    `  if curl -fsS --max-time 5 http://127.0.0.1:8188/object_info/H3StudioTAEH3PreviewLoader | grep -q '"H3StudioTAEH3PreviewLoader"'; then`,
    '    break',
    '  fi',
    '  attempt=$((attempt + 1))',
    '  sleep 1',
    'done',
    'if [ "$attempt" -gt 30 ]; then',
    '  echo "ComfyUI did not load H3StudioTAEH3PreviewLoader." >&2',
    '  exit 1',
    'fi',
  ];
}

function previewNodeInstallCommand({ nodeVersion, comfyContainer, comfyCustomNodesDir }) {
  const previewNodeDir = `${comfyCustomNodesDir}/h3_studio_taeh3_preview`;
  const loaderPath = `${previewNodeDir}/loader.py`;
  const expectedMarker = `NODE_VERSION = "${nodeVersion}"`;
  const installedVersionCheck = [
    `test -f ${shellQuote(loaderPath)}`,
    `grep -Fqx ${shellQuote(expectedMarker)} ${shellQuote(loaderPath)}`,
  ].join(' && ');
  return [
    `if ! docker exec ${comfyContainer} sh -lc ${shellQuote(installedVersionCheck)}; then`,
    `  docker exec -u 0 ${comfyContainer} mkdir -p ${shellQuote(previewNodeDir)}`,
    `  docker cp ${shellQuote(TAEH3_PREVIEW_NODE_SOURCE)} ${comfyContainer}:${previewNodeDir}/`,
    `  docker restart ${comfyContainer} >/dev/null`,
    ...previewNodeHealthCheckCommand().map((line) => `  ${line}`),
    'fi',
    ...previewNodeHealthCheckCommand(),
  ];
}

function healthCheckCommand() {
  return [
    'attempt=1',
    'while [ "$attempt" -le 15 ]; do',
    '  health="$(curl -fsS --max-time 5 http://127.0.0.1:5174/api/health || true)"',
    '  if printf "%s" "$health" | grep -q \'"fastH3Vsa"\' && printf "%s" "$health" | grep -q \'"taeH3Preview":{"available":true\' && printf "%s" "$health" | grep -q \'"flashVsr"\' && printf "%s" "$health" | grep -q \'"deterministicUpscale"\'; then',
    '    printf "%s\\n" "$health"',
    '    exit 0',
    '  fi',
    '  attempt=$((attempt + 1))',
    '  sleep 1',
    'done',
    'echo "H3 Studio did not expose the expected FastH3, TAEH3 preview, FlashVSR, and deterministic enhancement capabilities after deployment." >&2',
    'exit 1',
  ];
}

function flashVsrDeploymentCommand({ targetDir, modelDir, comfyOutputDir, comfyVenvDir }) {
  const stateDir = `${targetDir}/flashvsr-state`;
  const workDir = `${targetDir}/flashvsr-work`;
  const venvDir = `${targetDir}/flashvsr-venv`;
  const sourcesDir = `${targetDir}/flashvsr-sources`;
  const wheelhouseDir = `${targetDir}/flashvsr-wheelhouse`;
  const disabledState = (reason) => `printf '%s\\n' '${JSON.stringify({
    available: false,
    model: 'flashvsr-v1.1',
    supportedTargets: [],
    reason,
  })}' > "$flashvsr_state_dir/compatibility.json"`;
  return [
    '# FLASHVSR_DEPLOYMENT_STAGE',
    `flashvsr_model_dir=${shellQuote(modelDir)}`,
    `flashvsr_state_dir=${shellQuote(stateDir)}`,
    `flashvsr_work_dir=${shellQuote(workDir)}`,
    `flashvsr_output_dir=${shellQuote(comfyOutputDir)}`,
    `flashvsr_venv_source=${shellQuote(comfyVenvDir)}`,
    `flashvsr_venv_dir=${shellQuote(venvDir)}`,
    `flashvsr_sources_dir=${shellQuote(sourcesDir)}`,
    `flashvsr_wheelhouse_dir=${shellQuote(wheelhouseDir)}`,
    'install -d -m 0750 "$flashvsr_model_dir" "$flashvsr_state_dir" "$flashvsr_work_dir" "$flashvsr_sources_dir" "$flashvsr_wheelhouse_dir"',
    'chown "$(id -u):$(id -g)" "$flashvsr_model_dir" "$flashvsr_state_dir" "$flashvsr_work_dir" "$flashvsr_sources_dir" "$flashvsr_wheelhouse_dir"',
    'docker compose -f docker-compose.gb10.yml stop flashvsr-worker >/dev/null 2>&1 || true',
    'docker rm -f h3-studio-flashvsr-setup >/dev/null 2>&1 || true',
    'ensure_flashvsr_source() {',
    '  flashvsr_archive="$1"',
    '  flashvsr_url="$2"',
    '  flashvsr_prefix="$3"',
    '  if tar -tzf "$flashvsr_archive" 2>/dev/null | grep -q "^$flashvsr_prefix/"; then',
    '    return 0',
    '  fi',
    '  flashvsr_source_stage=$(mktemp "$flashvsr_sources_dir/.flashvsr-source.XXXXXX")',
    '  curl -fL --retry 3 --retry-all-errors --connect-timeout 20 --max-time 900 -o "$flashvsr_source_stage" "$flashvsr_url"',
    '  tar -tzf "$flashvsr_source_stage" | grep -q "^$flashvsr_prefix/"',
    '  mv "$flashvsr_source_stage" "$flashvsr_archive"',
    '}',
    'flashvsr_sources_ready=0',
    'if ensure_flashvsr_source "$flashvsr_sources_dir/FlashVSR.tar.gz" "https://codeload.github.com/OpenImagingLab/FlashVSR/tar.gz/cf910c61a60733e610e9c6e8b607f80c3a6c202b" "FlashVSR-cf910c61a60733e610e9c6e8b607f80c3a6c202b" && ensure_flashvsr_source "$flashvsr_sources_dir/Block-Sparse-Attention.tar.gz" "https://codeload.github.com/mit-han-lab/Block-Sparse-Attention/tar.gz/49d6c39e4dc0303442cda3bb758b3925d4399c49" "Block-Sparse-Attention-49d6c39e4dc0303442cda3bb758b3925d4399c49" && ensure_flashvsr_source "$flashvsr_sources_dir/CUTLASS.tar.gz" "https://codeload.github.com/NVIDIA/cutlass/tar.gz/a75b4ac483166189a45290783cb0a18af5ff0ea5" "cutlass-a75b4ac483166189a45290783cb0a18af5ff0ea5"; then',
    '  flashvsr_sources_ready=1',
    'else',
    `  ${disabledState('sources: FlashVSR 官方源码下载失败。')}`,
    'fi',
    'flashvsr_venv_ready=0',
    'flashvsr_runtime_ready=0',
    'if [ "$flashvsr_sources_ready" -ne 1 ]; then',
    '  :',
    'elif [ ! -x "$flashvsr_venv_source/bin/python" ]; then',
    `  ${disabledState('runtime: FlashVSR 私有虚拟环境准备失败。')}`,
    'elif [ -e "$flashvsr_venv_dir" ] && [ ! -x "$flashvsr_venv_dir/bin/python" ]; then',
    `  ${disabledState('runtime: FlashVSR 私有虚拟环境准备失败。')}`,
    'elif [ ! -x "$flashvsr_venv_dir/bin/python" ]; then',
    `  if flashvsr_venv_stage=$(mktemp -d ${shellQuote(`${targetDir}/.flashvsr-venv-stage.XXXXXX`)}) && cp -a "$flashvsr_venv_source/." "$flashvsr_venv_stage/" && mv "$flashvsr_venv_stage" "$flashvsr_venv_dir"; then`,
    '    flashvsr_venv_ready=1',
    '  else',
    `    ${disabledState('runtime: FlashVSR 私有虚拟环境准备失败。')}`,
    '  fi',
    'else',
    '  flashvsr_venv_ready=1',
    'fi',
    'if [ "$flashvsr_sources_ready" -eq 1 ] && [ "$flashvsr_venv_ready" -eq 1 ] && docker compose -f docker-compose.gb10.yml build flashvsr-worker; then',
    '  if docker run --name h3-studio-flashvsr-setup --rm --network host --gpus all -e PYTHONPATH=/opt/h3-studio -e PIP_FIND_LINKS=/wheelhouse -e PIP_NO_INDEX=1 -e BLOCK_SPARSE_ATTN_FORCE_BUILD=TRUE -e BLOCK_SPARSE_ATTN_CUDA_ARCHS=120 -v "$flashvsr_venv_dir:/flashvsr-venv" -v "$flashvsr_wheelhouse_dir:/wheelhouse:ro" h3-studio-flashvsr:gb10 /flashvsr-venv/bin/python -m flashvsr_worker.install_runtime; then',
    '    flashvsr_runtime_ready=1',
    '    if docker run --rm --network host -e PYTHONPATH=/opt/h3-studio -v "$flashvsr_venv_dir:/flashvsr-venv" -v "$flashvsr_model_dir:/models/FlashVSR" -v "$flashvsr_state_dir:/state" h3-studio-flashvsr:gb10 /flashvsr-venv/bin/python -m flashvsr_worker.install_model; then',
    '      if docker run --rm --network host --gpus all --memory 56g --memory-swap 56g -e PYTHONPATH=/opt/h3-studio -v "$flashvsr_venv_dir:/flashvsr-venv:ro" -v "$flashvsr_model_dir:/models/FlashVSR:ro" -v "$flashvsr_state_dir:/state" -v "$flashvsr_work_dir:/work" -v "$flashvsr_output_dir:/comfy-output:ro" h3-studio-flashvsr:gb10 /flashvsr-venv/bin/python -m flashvsr_worker.gate; then',
    '        echo "FlashVSR compatibility gate passed."',
    '      else',
    '        flashvsr_gate_status=$?',
    '        if [ "$flashvsr_gate_status" -eq 137 ]; then',
    `          ${disabledState('resources: FlashVSR compatibility gate exited 137; tiled 720P validation did not complete.')}`,
    '        fi',
    '        echo "FlashVSR compatibility gate failed; starting only its disabled-status endpoint." >&2',
    '      fi',
    '    else',
    `      ${disabledState('assets: ModelScope installation failed.')}`,
    '    fi',
    '  else',
    `    ${disabledState('runtime: FlashVSR 私有依赖安装失败。')}`,
    '  fi',
    'elif [ "$flashvsr_sources_ready" -eq 1 ] && [ "$flashvsr_venv_ready" -eq 1 ]; then',
    `  ${disabledState('imports: FlashVSR worker image build failed.')}`,
    'fi',
    'if [ "$flashvsr_runtime_ready" -eq 1 ]; then',
    '  docker compose -f docker-compose.gb10.yml up -d --no-build flashvsr-worker || true',
    'fi',
  ];
}

function composeEnvironmentCommand({
  targetDir,
  comfyOutputDir,
  comfyVenvDir,
  flashVsrModelDir,
  realesrganModelSource,
  comfyContainer,
  comfyCustomNodesDir,
}) {
  return [
    `export H3_STUDIO_GB10_DIR=${shellQuote(targetDir)}`,
    `export H3_STUDIO_COMFY_OUTPUT_DIR=${shellQuote(comfyOutputDir)}`,
    `export H3_STUDIO_COMFY_VENV_DIR=${shellQuote(comfyVenvDir)}`,
    `export H3_STUDIO_FLASHVSR_MODEL_DIR=${shellQuote(flashVsrModelDir)}`,
    `export H3_STUDIO_REALESRGAN_MODEL_SOURCE=${shellQuote(realesrganModelSource)}`,
    `export H3_STUDIO_COMFY_CONTAINER=${shellQuote(comfyContainer)}`,
    `export H3_STUDIO_COMFY_CUSTOM_NODES_DIR=${shellQuote(comfyCustomNodesDir)}`,
  ];
}

function deterministicUpscaleDeploymentCommand({ targetDir, modelSource }) {
  const modelDir = `${targetDir}/realesrgan-models`;
  const stateDir = `${targetDir}/realesrgan-state`;
  const workDir = `${targetDir}/realesrgan-work`;
  return [
    '# DETERMINISTIC_UPSCALE_DEPLOYMENT_STAGE',
    `realesrgan_model_source=${shellQuote(modelSource)}`,
    `realesrgan_model_dir=${shellQuote(modelDir)}`,
    `realesrgan_state_dir=${shellQuote(stateDir)}`,
    `realesrgan_work_dir=${shellQuote(workDir)}`,
    `realesrgan_model_filename=${shellQuote(REALESRGAN_MODEL_FILENAME)}`,
    `realesrgan_model_sha256=${shellQuote(REALESRGAN_MODEL_SHA256)}`,
    'install -d -m 0750 "$realesrgan_model_dir" "$realesrgan_state_dir" "$realesrgan_work_dir"',
    'chown "$(id -u):$(id -g)" "$realesrgan_model_dir" "$realesrgan_state_dir" "$realesrgan_work_dir"',
    'realesrgan_model_valid() {',
    '  test -f "$1" && test "$(sha256sum "$1" | cut -d " " -f 1)" = "$realesrgan_model_sha256"',
    '}',
    'realesrgan_model_path="$realesrgan_model_dir/$realesrgan_model_filename"',
    'if ! realesrgan_model_valid "$realesrgan_model_path"; then',
    '  if realesrgan_model_valid "$realesrgan_model_source"; then',
    '    realesrgan_stage=$(mktemp "$realesrgan_model_dir/.realesrgan-model.XXXXXX")',
    '    cp "$realesrgan_model_source" "$realesrgan_stage"',
    '    if realesrgan_model_valid "$realesrgan_stage"; then',
    '      mv -f "$realesrgan_stage" "$realesrgan_model_path"',
    '      chmod 0640 "$realesrgan_model_path"',
    '    else',
    '      rm -f "$realesrgan_stage"',
    '      echo "RealESRGAN staged model checksum verification failed." >&2',
    '    fi',
    '  else',
    '    echo "Verified RealESRGAN model source is unavailable; worker will remain fail-closed." >&2',
    '  fi',
    'fi',
    'docker compose -f docker-compose.gb10.yml stop realesrgan-worker >/dev/null 2>&1 || true',
    'docker compose -f docker-compose.gb10.yml build realesrgan-worker',
    'docker compose -f docker-compose.gb10.yml up -d --no-build realesrgan-worker',
  ];
}

export function createGb10DeploymentPlan({
  sourceDir = process.cwd(),
  host = process.env.H3_STUDIO_GB10_HOST ?? DEFAULT_GB10_HOST,
  targetDir = process.env.H3_STUDIO_GB10_DIR ?? DEFAULT_GB10_DIR,
  comfyOutputDir = process.env.H3_STUDIO_COMFY_OUTPUT_DIR ?? DEFAULT_COMFY_OUTPUT_DIR,
  comfyVenvDir = process.env.H3_STUDIO_COMFY_VENV_DIR ?? DEFAULT_COMFY_VENV_DIR,
  flashVsrModelDir = process.env.H3_STUDIO_FLASHVSR_MODEL_DIR ?? DEFAULT_FLASHVSR_MODEL_DIR,
  comfyContainer = process.env.H3_STUDIO_COMFY_CONTAINER ?? DEFAULT_COMFY_CONTAINER,
  comfyCustomNodesDir = process.env.H3_STUDIO_COMFY_CUSTOM_NODES_DIR ?? DEFAULT_COMFY_CUSTOM_NODES_DIR,
  realesrganModelSource,
  previewNodeVersion,
} = {}) {
  const safeHost = validateHost(host);
  const source = withTrailingSlash(validateDirectory(resolve(sourceDir), 'sourceDir'));
  const safeTargetDir = validateDirectory(targetDir, 'H3_STUDIO_GB10_DIR');
  const target = withTrailingSlash(safeTargetDir);
  const safeComfyOutputDir = validateDirectory(comfyOutputDir, 'H3_STUDIO_COMFY_OUTPUT_DIR');
  const safeComfyVenvDir = validateDirectory(comfyVenvDir, 'H3_STUDIO_COMFY_VENV_DIR');
  const safeFlashVsrModelDir = validateDirectory(flashVsrModelDir, 'H3_STUDIO_FLASHVSR_MODEL_DIR');
  const safeComfyContainer = validateContainerName(comfyContainer, 'H3_STUDIO_COMFY_CONTAINER');
  const safeComfyCustomNodesDir = validateDirectory(comfyCustomNodesDir, 'H3_STUDIO_COMFY_CUSTOM_NODES_DIR');
  const safeRealesrganModelSource = validateDirectory(
    realesrganModelSource
      ?? process.env.H3_STUDIO_REALESRGAN_MODEL_SOURCE
      ?? `${safeTargetDir}/model-staging/RealESRGAN_x2plus__spike.pth`,
    'H3_STUDIO_REALESRGAN_MODEL_SOURCE',
  );
  const resolvedPreviewNodeVersion = previewNodeVersion ?? readTaeH3PreviewNodeVersion(source);
  if (!/^[A-Za-z0-9._-]+$/.test(resolvedPreviewNodeVersion)) {
    throw new Error('TAEH3 预览节点版本不合法。');
  }
  const rsyncArgs = [
    '-a',
    ...EXCLUDES.flatMap((entry) => ['--exclude', entry]),
    source,
    `${safeHost}:${target}`,
  ];
  const remoteEnvironment = composeEnvironmentCommand({
    targetDir: safeTargetDir,
    comfyOutputDir: safeComfyOutputDir,
    comfyVenvDir: safeComfyVenvDir,
    flashVsrModelDir: safeFlashVsrModelDir,
    realesrganModelSource: safeRealesrganModelSource,
    comfyContainer: safeComfyContainer,
    comfyCustomNodesDir: safeComfyCustomNodesDir,
  });
  const remoteCommand = [
    'set -eu',
    ...remoteEnvironment,
    `cd ${shellQuote(target.slice(0, -1))}`,
    ...previewNodeInstallCommand({
      nodeVersion: resolvedPreviewNodeVersion,
      comfyContainer: safeComfyContainer,
      comfyCustomNodesDir: safeComfyCustomNodesDir,
    }),
    'docker compose -f docker-compose.gb10.yml up -d --build h3-studio',
    ...deterministicUpscaleDeploymentCommand({ targetDir: target.slice(0, -1), modelSource: safeRealesrganModelSource }),
    ...flashVsrDeploymentCommand({
      targetDir: target.slice(0, -1),
      modelDir: safeFlashVsrModelDir,
      comfyOutputDir: safeComfyOutputDir,
      comfyVenvDir: safeComfyVenvDir,
    }),
    ...healthCheckCommand(),
  ].join('\n');
  const fallbackCommand = [
    'set -eu',
    ...remoteEnvironment,
    `cd ${shellQuote(target.slice(0, -1))}`,
    ...previewNodeInstallCommand({
      nodeVersion: resolvedPreviewNodeVersion,
      comfyContainer: safeComfyContainer,
      comfyCustomNodesDir: safeComfyCustomNodesDir,
    }),
    'docker build --file Dockerfile.release --tag h3-studio:gb10 .',
    'docker compose -f docker-compose.gb10.yml up -d --no-build h3-studio',
    ...deterministicUpscaleDeploymentCommand({ targetDir: target.slice(0, -1), modelSource: safeRealesrganModelSource }),
    ...flashVsrDeploymentCommand({
      targetDir: target.slice(0, -1),
      modelDir: safeFlashVsrModelDir,
      comfyOutputDir: safeComfyOutputDir,
      comfyVenvDir: safeComfyVenvDir,
    }),
    ...healthCheckCommand(),
  ].join('\n');

  return {
    rsyncArgs,
    sshArgs: [safeHost, remoteCommand],
    fallbackSshArgs: [safeHost, fallbackCommand],
  };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return false;
    throw new Error(`${command} 退出，状态码 ${result.status ?? 'unknown'}。`);
  }
  return true;
}

export function deployGb10(options) {
  const plan = createGb10DeploymentPlan(options);
  console.log('构建本机 H3 Studio 生产产物，供 GB10 镜像构建和网络回退使用。');
  run('npm', ['run', 'build']);
  console.log(`同步 H3 Studio 源码和已验证产物到 ${plan.sshArgs[0]}，不会传输 secrets。`);
  run('rsync', plan.rsyncArgs);
  console.log('先重建 GB10 上的 h3-studio，再独立构建并验证 FlashVSR compatibility gate。');
  if (!run('ssh', plan.sshArgs, { allowFailure: true })) {
    console.warn('远端依赖构建失败；依赖未变时，使用已验证的本机产物重新封装现有 GB10 运行镜像。');
    run('ssh', plan.fallbackSshArgs);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadCliEnvironment();
    deployGb10();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'GB10 部署失败。');
    process.exitCode = 1;
  }
}
