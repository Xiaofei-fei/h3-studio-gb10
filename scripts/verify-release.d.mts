export function verifyReleaseContent(content: string): string[];
export function verifyReleasePaths(paths: string[], options?: {
  readText?: (path: string) => string | null;
}): string[];
export function runReleaseVerification(options?: { paths?: string[] }): {
  status: number;
  failures: string[];
};
