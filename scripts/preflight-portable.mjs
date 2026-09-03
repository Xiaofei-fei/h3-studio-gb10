import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePortableEnvironment } from './deploy-gb10.mjs';

export const REQUIRED_PORTABLE_VARIABLES = [
  'H3_STUDIO_GB10_HOST',
  'H3_STUDIO_GB10_DIR',
  'H3_STUDIO_COMFY_OUTPUT_DIR',
  'H3_STUDIO_COMFY_VENV_DIR',
  'H3_STUDIO_FLASHVSR_MODEL_DIR',
  'H3_STUDIO_REALESRGAN_MODEL_SOURCE',
  'H3_STUDIO_COMFY_CONTAINER',
  'H3_STUDIO_COMFY_CUSTOM_NODES_DIR',
];

function missingPortableVariables(environment) {
  return REQUIRED_PORTABLE_VARIABLES.filter((key) => !String(environment[key] ?? '').trim());
}

function runDockerComposeConfig({ environment, envFilePath, composeFilePath }) {
  const version = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) return { available: false, status: 0 };

  const args = ['compose'];
  if (envFilePath) args.push('--env-file', envFilePath);
  args.push('-f', composeFilePath, 'config');
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
  return { available: true, status: result.status ?? 1 };
}

export function runPreflight({
  environment = process.env,
  envFilePath,
  composeFilePath = resolve(process.cwd(), 'docker-compose.gb10.yml'),
  validateCompose = true,
  requireDocker = false,
  composeValidator,
} = {}) {
  const stdout = [];
  const stderr = [];
  const missing = missingPortableVariables(environment);
  if (missing.length) {
    stderr.push(`缺少必填配置：${missing.join(', ')}`);
    return { status: 1, stdout, stderr };
  }

  stdout.push('H3 Studio 可迁移配置检查通过。');
  if (!validateCompose) return { status: 0, stdout, stderr };

  const validator = composeValidator ?? runDockerComposeConfig;
  const composeResult = validator({ environment, envFilePath, composeFilePath });
  if (composeResult.status !== 0) {
    stderr.push('Docker Compose 配置验证失败；未启动或修改任何容器。');
    return { status: 1, stdout, stderr };
  }
  const composeAvailable = composeResult.available !== false;
  if (!composeAvailable && requireDocker) {
    stderr.push('未找到 Docker Compose；GB10 部署前必须安装并执行配置验证。');
    return { status: 1, stdout, stderr };
  }
  if (!composeAvailable) {
    stdout.push('未找到 Docker Compose，已跳过 Compose 展开；请在 GB10 上使用 --require-docker 重跑。');
    return { status: 0, stdout, stderr };
  }

  stdout.push('Docker Compose 配置验证通过。');
  return { status: 0, stdout, stderr };
}

function parseCliOptions(args) {
  let envFilePath = '.env';
  let explicitEnvFile = false;
  let requireDocker = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--h3-env-file') {
      envFilePath = args[index + 1] ?? '';
      explicitEnvFile = true;
      index += 1;
    } else if (args[index] === '--require-docker') {
      requireDocker = true;
    } else {
      throw new Error(`不支持的参数：${args[index]}`);
    }
  }
  if (!envFilePath) throw new Error('--h3-env-file 需要一个文件路径。');
  return { envFilePath: resolve(process.cwd(), envFilePath), explicitEnvFile, requireDocker };
}

function runCli() {
  const options = parseCliOptions(process.argv.slice(2));
  const hasEnvFile = existsSync(options.envFilePath);
  if (!hasEnvFile && options.explicitEnvFile) {
    return { status: 1, stdout: [], stderr: [`找不到指定的环境配置文件：${options.envFilePath}`] };
  }
  const fileEnvironment = hasEnvFile
    ? parsePortableEnvironment(readFileSync(options.envFilePath, 'utf8'))
    : {};
  return runPreflight({
    environment: { ...fileEnvironment, ...process.env },
    envFilePath: hasEnvFile ? options.envFilePath : undefined,
    requireDocker: options.requireDocker,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runCli();
    if (result.stdout.length) process.stdout.write(`${result.stdout.join('\n')}\n`);
    if (result.stderr.length) process.stderr.write(`${result.stderr.join('\n')}\n`);
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : '可迁移部署预检失败。');
    process.exitCode = 1;
  }
}
