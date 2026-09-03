import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function forbiddenPathReason(path) {
  if (/\.(?:safetensors|ckpt|pth|pt)$/i.test(path)) return 'model weight';
  if (/(?:^|\/)(?:models|model-staging|outputs|input|flashvsr-(?:venv|wheelhouse|sources|state|work)|realesrgan-(?:models|state|work))(?:\/|$)/.test(path)) {
    return 'runtime artifact';
  }
  if (path === '.env' || (path.startsWith('.env.') && path !== '.env.example')) return 'private config';
  if (/(?:^|\/)(?:\.secrets|\.playwright-cli|\.wrangler)(?:\/|$)/.test(path)) return 'private config';
  if (path === 'cloudflare-worker/wrangler.jsonc') return 'private config';
  if (/\.(?:mp4|mov|webm|mkv|wav|mp3|flac)$/i.test(path)) return 'generated media';
  return null;
}

export function verifyReleaseContent(content) {
  const credentialPatterns = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /(?:CF_API_TOKEN|CLOUDFLARE_API_TOKEN)\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/i,
  ];
  return credentialPatterns.some((pattern) => pattern.test(content))
    ? ['credential-like content']
    : [];
}

function readTrackedText(path) {
  const content = readFileSync(path);
  return content.includes(0) ? null : content.toString('utf8');
}

export function verifyReleasePaths(paths, { readText = readTrackedText } = {}) {
  const failures = [];
  for (const path of paths) {
    const pathReason = forbiddenPathReason(path);
    if (pathReason) {
      failures.push(`${path}: ${pathReason}`);
      continue;
    }
    try {
      const content = readText(path);
      if (content !== null) {
        for (const reason of verifyReleaseContent(content)) failures.push(`${path}: ${reason}`);
      }
    } catch {
      failures.push(`${path}: unreadable tracked file`);
    }
  }
  return failures;
}

function readTrackedPaths() {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'buffer' });
  if (result.error || result.status !== 0) throw new Error('无法读取 Git 已跟踪文件。');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

export function runReleaseVerification({ paths = readTrackedPaths() } = {}) {
  const failures = verifyReleasePaths(paths);
  return {
    status: failures.length ? 1 : 0,
    failures,
  };
}

function parseCliPaths(args) {
  if (!args.length) return undefined;
  if (args[0] !== '--paths' || args.length === 1) {
    throw new Error('仅支持 --paths <path...>，或不带参数扫描 Git 已跟踪文件。');
  }
  return args.slice(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runReleaseVerification({ paths: parseCliPaths(process.argv.slice(2)) });
    if (result.failures.length) {
      for (const failure of result.failures) console.error(`阻止发布：${failure}`);
    } else {
      console.log('发布安全扫描通过。');
    }
    process.exitCode = result.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : '发布安全扫描失败。');
    process.exitCode = 1;
  }
}
