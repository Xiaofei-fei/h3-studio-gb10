export const HTML_CACHE_CONTROL = 'no-cache';
export const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function cacheControlForStaticFile(filePath: string): string | undefined {
  if (filePath.endsWith('.html')) return HTML_CACHE_CONTROL;
  if (/(^|[\\/])assets[\\/]/.test(filePath)) return HASHED_ASSET_CACHE_CONTROL;
  return undefined;
}
