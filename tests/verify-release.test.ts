import { describe, expect, it } from 'vitest';
import { verifyReleaseContent, verifyReleasePaths } from '../scripts/verify-release.mjs';

describe('release safety verification', () => {
  it('rejects forbidden release paths and credential-like content', () => {
    expect(verifyReleasePaths(['weights/model.safetensors']).join('\n')).toContain('model weight');
    expect(verifyReleasePaths(['cloudflare-worker/wrangler.jsonc']).join('\n')).toContain('private config');
    expect(verifyReleaseContent('ghp_exampleToken').join('\n')).toContain('credential-like content');
  });

  it('allows the safe example environment file', () => {
    expect(verifyReleasePaths(['.env.example'])).toEqual([]);
  });
});
