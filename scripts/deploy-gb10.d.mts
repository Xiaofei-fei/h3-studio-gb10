export interface Gb10DeploymentPlan {
  rsyncArgs: string[];
  sshArgs: [string, string];
  fallbackSshArgs: [string, string];
}

export interface Gb10DeploymentOptions {
  sourceDir?: string;
  host?: string;
  targetDir?: string;
  comfyOutputDir?: string;
  comfyVenvDir?: string;
  flashVsrModelDir?: string;
  comfyContainer?: string;
  comfyCustomNodesDir?: string;
  realesrganModelSource?: string;
  previewNodeVersion?: string;
}

export function parsePortableEnvironment(source: string): Record<string, string>;
export function createGb10DeploymentPlan(options?: Gb10DeploymentOptions): Gb10DeploymentPlan;
export function deployGb10(options?: Gb10DeploymentOptions): void;
