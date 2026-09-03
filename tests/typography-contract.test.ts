import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('H3 Studio typography contract', () => {
  it('uses a readable UI scale for customer-facing descriptions and optimization controls', () => {
    expect(stylesheet).toMatch(/--font-ui:.*Segoe UI Variable/);
    expect(stylesheet).toContain('--text-body: 14px');
    expect(stylesheet).toContain('--text-label: 13px');
    expect(stylesheet).toContain('--text-meta: 12px');
    expect(stylesheet).toMatch(/\.field-hint\s*\{[^}]*font-size:\s*var\(--text-meta\)/s);
    expect(stylesheet).toMatch(/\.feature-cache-copy small\s*\{[^}]*font-family:\s*var\(--font-ui\)[^}]*font-size:\s*var\(--text-meta\)/s);
    expect(stylesheet).toMatch(/\.cache-profile-buttons button\s*\{[^}]*font-family:\s*var\(--font-ui\)[^}]*font-size:\s*var\(--text-meta\)/s);
    expect(stylesheet).toMatch(/\.optimization-status\s*\{[^}]*font-family:\s*var\(--font-ui\)[^}]*font-size:\s*var\(--text-meta\)/s);
  });
});
