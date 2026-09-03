import { describe, expect, it } from 'vitest';
import { cacheControlForStaticFile, HTML_CACHE_CONTROL, HASHED_ASSET_CACHE_CONTROL } from '../server/static-cache';

describe('static cache policy', () => {
  it('keeps the HTML entry point revalidating while allowing hashed Vite assets to remain immutable', () => {
    expect(cacheControlForStaticFile('/srv/h3-studio/dist/index.html')).toBe(HTML_CACHE_CONTROL);
    expect(cacheControlForStaticFile('/srv/h3-studio/dist/assets/index-Bry0_x-r.js')).toBe(HASHED_ASSET_CACHE_CONTROL);
    expect(cacheControlForStaticFile('/srv/h3-studio/dist/assets/index-oU4TqkHc.css')).toBe(HASHED_ASSET_CACHE_CONTROL);
  });

  it('does not invent an aggressive cache policy for non-hashed public files', () => {
    expect(cacheControlForStaticFile('/srv/h3-studio/dist/favicon.svg')).toBeUndefined();
  });
});
