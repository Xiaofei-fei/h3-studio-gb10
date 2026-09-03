export const REQUIRED_PORTABLE_VARIABLES: string[];

export interface PreflightResult {
  status: number;
  stdout: string[];
  stderr: string[];
}

export interface ComposeValidationResult {
  available?: boolean;
  status: number;
}

export function runPreflight(options?: {
  environment?: Record<string, string | undefined>;
  envFilePath?: string;
  composeFilePath?: string;
  validateCompose?: boolean;
  requireDocker?: boolean;
  composeValidator?: (options: Record<string, unknown>) => ComposeValidationResult;
}): PreflightResult;
