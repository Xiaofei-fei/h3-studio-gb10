import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const docs = [
  'docs/getting-started.md',
  'docs/deployment-gb10.md',
  'docs/architecture.md',
  'docs/optimization-guide.md',
  'docs/model-and-node-manifest.md',
  'docs/downloads.md',
  'docs/upscale.md',
  'docs/troubleshooting.md',
  'docs/security-and-secrets.md',
];

describe('portable documentation contract', () => {
  it('links migration docs from README without active-machine paths or token-like text', () => {
    const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
    for (const doc of docs) {
      expect(existsSync(resolve(process.cwd(), doc))).toBe(true);
      expect(readme).toContain(doc);
    }
    const publicDocumentation = [readme, ...docs.map((doc) => readFileSync(resolve(process.cwd(), doc), 'utf8'))].join('\n');
    expect(publicDocumentation).not.toMatch(/\/home\/[A-Za-z0-9_-]+\//);
    expect(publicDocumentation).not.toMatch(/(?:ghp_|github_pat_)[A-Za-z0-9_]{8,}/);
  });
});
