import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('portable repository hygiene', () => {
  it('ignores mutable and secret state while leaving user-facing docs trackable', () => {
    const gitignore = readWorkspaceFile('.gitignore');
    const dockerignore = readWorkspaceFile('.dockerignore');

    for (const entry of [
      '.env',
      'models/',
      'outputs/',
      '.playwright-cli/',
      'cloudflare-worker/wrangler.jsonc',
      'realesrgan-models/',
      'flashvsr-venv/',
    ]) {
      expect(gitignore).toContain(entry);
    }
    expect(gitignore).not.toMatch(/^docs\/?$/m);
    expect(gitignore).toContain('docs/superpowers/plans/*');
    expect(gitignore).toContain('!docs/superpowers/plans/2026-09-03-h3-studio-portable-github.md');
    expect(gitignore).toContain('docs/superpowers/specs/*');
    expect(gitignore).toContain('!docs/superpowers/specs/2026-09-03-h3-studio-portable-github-design.md');
    expect(dockerignore).toMatch(/^\.playwright-cli\/?$/m);
    expect(dockerignore).toContain('cloudflare-worker/wrangler.jsonc');
  });
});
