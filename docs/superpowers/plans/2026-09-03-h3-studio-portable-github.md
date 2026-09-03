# H3 Studio Portable GitHub Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Publish the current H3 Studio system as private repository Xiaofei-fei/h3-studio-gb10 with portable GB10 deployment templates, a full operating guide and no models or credentials.

**Architecture:** Preserve the existing frontend, BFF, ComfyUI workflow builder, TAEH3 node, FlashVSR worker and RealESRGAN worker. Add one safe environment contract used by Docker Compose and the GB10 deployment script. Git contains only source, templates, tests and documentation.

**Tech Stack:** TypeScript, React, Vite, Express, Vitest, Python, Docker Compose, SSH/rsync and Git.

**Spec:** docs/superpowers/specs/2026-09-03-h3-studio-portable-github-design.md

**Execution status (2026-09-03):** Tasks 1–4 are complete. Task 5 remains pending GitHub device authentication, private remote creation, push and clean-clone verification.

## Global Constraints

- Never stage model weights, generated media, virtual environments, cache directories, SSH material, Cloudflare config or GitHub credentials.
- Preserve worker compatibility gates and capability reporting.
- Preserve npm test, npm run check and npm run build.
- Use placeholder host/path values in tracked configuration and documentation.
- Do not push before tests, build, Compose preflight and release scan pass.

---

### Task 1: Define a publishable Git boundary

**Files:**
- Modify: .gitignore
- Modify: .dockerignore
- Create: LICENSE
- Create: tests/repository-hygiene.test.ts

**Interfaces:**
- Consumes: current workspace and Docker build context.
- Produces: an explicit allow/deny boundary for source code, documentation and local state.

- [ ] **Step 1: Write the failing hygiene test**

~~~ts
it('keeps portable docs and templates while excluding mutable and secret state', () => {
  const ignore = readFileSync('.gitignore', 'utf8');
  for (const entry of ['.env', 'models/', 'outputs/', '.playwright-cli/', 'cloudflare-worker/wrangler.jsonc']) {
    expect(ignore).toContain(entry);
  }
  expect(ignore).not.toMatch(/^docs\/?$/m);
});
~~~

- [ ] **Step 2: Confirm RED**

Run: npm test -- tests/repository-hygiene.test.ts

Expected: FAIL because several generated/private paths are not yet ignored and docs are ignored broadly.

- [ ] **Step 3: Implement boundary rules**

Use these Git ignores:

~~~gitignore
node_modules/
dist/
server-dist/
coverage/
.env
.env.*
!.env.example
.cloudflared.env
.secrets/
.playwright-cli/
__pycache__/
.pytest_cache/
*.py[cod]
models/
model-staging/
outputs/
input/
flashvsr-venv/
flashvsr-wheelhouse/
flashvsr-sources/
flashvsr-state/
flashvsr-work/
realesrgan-models/
realesrgan-state/
realesrgan-work/
cloudflare-worker/wrangler.jsonc
~~~

Remove the broad docs ignore. Mirror generated-artifact and secret exclusions in .dockerignore. Add MIT LICENSE attributed to Xiaoffy. Keep the actual Cloudflare configuration on disk but untracked.

- [ ] **Step 4: Verify GREEN**

Run: npm test -- tests/repository-hygiene.test.ts

Run: git check-ignore -v cloudflare-worker/wrangler.jsonc node_modules dist .playwright-cli || true

Expected: PASS; actual config/outputs are ignored and public docs can be tracked.

- [ ] **Step 5: Commit**

~~~bash
git add .gitignore .dockerignore LICENSE tests/repository-hygiene.test.ts
git commit -m "chore: define portable repository boundary"
~~~

### Task 2: Add a portable GB10 configuration contract

**Files:**
- Create: .env.example
- Create: config/model-manifest.yaml
- Create: config/comfy-capabilities.md
- Modify: docker-compose.gb10.yml
- Modify: scripts/deploy-gb10.mjs
- Modify: tests/deploy-gb10.test.ts
- Create: tests/portable-config.test.ts

**Interfaces:**
- Consumes: current GB10 host paths, Compose mounts and deployment-plan factory.
- Produces: one environment-variable schema used by Compose and SSH deployment.

- [ ] **Step 1: Write failing configuration tests**

~~~ts
const required = [
  'H3_STUDIO_GB10_DIR',
  'H3_STUDIO_COMFY_OUTPUT_DIR',
  'H3_STUDIO_COMFY_VENV_DIR',
  'H3_STUDIO_FLASHVSR_MODEL_DIR',
  'H3_STUDIO_REALESRGAN_MODEL_SOURCE',
];

it('uses portable variables in GB10 Compose mounts', () => {
  const compose = readFileSync('docker-compose.gb10.yml', 'utf8');
  const example = readFileSync('.env.example', 'utf8');
  for (const variable of required) {
    expect(example).toContain(variable + '=');
    expect(compose).toContain(variable);
  }
});
~~~

Add a deployment-plan fixture with literals /srv/h3-studio, /srv/comfy/output, /srv/comfy/venv, comfyui and /comfy/custom_nodes. Assert the generated remote command contains all five literals.

- [ ] **Step 2: Confirm RED**

Run: npm test -- tests/portable-config.test.ts tests/deploy-gb10.test.ts

Expected: FAIL because current Compose and deployment script contain active-host paths/container names.

- [ ] **Step 3: Create safe .env.example**

~~~dotenv
H3_STUDIO_GB10_HOST=gb10
H3_STUDIO_GB10_DIR=/opt/h3-studio
H3_STUDIO_COMFY_OUTPUT_DIR=/opt/comfyui/output
H3_STUDIO_COMFY_VENV_DIR=/opt/comfyui/venv
H3_STUDIO_FLASHVSR_MODEL_DIR=/opt/models/FlashVSR
H3_STUDIO_REALESRGAN_MODEL_SOURCE=/opt/model-staging/RealESRGAN_x2plus.pth
H3_STUDIO_COMFY_CONTAINER=comfyui
H3_STUDIO_COMFY_CUSTOM_NODES_DIR=/comfy/mnt/ComfyUI/custom_nodes
~~~

- [ ] **Step 4: Parameterize runtime configuration**

Replace every Compose host mount with required environment interpolation. Use the same values to extend createGb10DeploymentPlan with comfyOutputDir, comfyVenvDir, comfyContainer and comfyCustomNodesDir. Retain existing safe host/path validation, shell quoting and worker gate behavior.

- [ ] **Step 5: Add external dependency manifests**

Create config/model-manifest.yaml with file name, role, precision, source class, known checksum and redistributable: false. Create config/comfy-capabilities.md for Standard, FastH3 VSA, Music3, TAEH3 preview, VAE tile batch, cuBLAS/AdaGEMM and both upscalers.

- [ ] **Step 6: Verify GREEN**

~~~bash
npm test -- tests/portable-config.test.ts tests/deploy-gb10.test.ts
docker compose --env-file .env.example -f docker-compose.gb10.yml config >/tmp/h3-studio-compose.yaml
~~~

Expected: tests PASS and Compose parses example paths.

- [ ] **Step 7: Commit**

~~~bash
git add .env.example config docker-compose.gb10.yml scripts/deploy-gb10.mjs tests
git commit -m "feat: make GB10 deployment portable"
~~~

### Task 3: Add preflight and release-safety commands

**Files:**
- Create: scripts/preflight-portable.mjs
- Create: scripts/verify-release.mjs
- Modify: package.json
- Create: tests/preflight-portable.test.ts
- Create: tests/verify-release.test.ts

**Interfaces:**
- Consumes: Task 2 schema, Compose file and Git index.
- Produces: non-mutating configuration and release gates.

- [ ] **Step 1: Write failing tests**

~~~ts
it('reports a missing portable setting without printing its value', () => {
  const result = runPreflight({ H3_STUDIO_GB10_DIR: '' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('H3_STUDIO_GB10_DIR');
});

it('rejects forbidden release paths and token-like content', () => {
  expect(verify(['weights/model.safetensors'])).toContain('model weight');
  expect(verify(['cloudflare-worker/wrangler.jsonc'])).toContain('private config');
  expect(verifyContent(['ghp', 'exampleToken'].join('_'))).toContain('credential-like');
});
~~~

- [ ] **Step 2: Confirm RED**

Run: npm test -- tests/preflight-portable.test.ts tests/verify-release.test.ts

Expected: FAIL because no verifier scripts exist.

- [ ] **Step 3: Implement scripts**

preflight-portable.mjs accepts --h3-env-file, checks each required value without printing it and runs Docker Compose config validation when Docker is available. It never opens SSH, downloads models or mutates Docker.

verify-release.mjs uses git ls-files -z by default and --paths for tests, rejects forbidden paths and narrow credential patterns, prints only file/reason and exits non-zero on violation.

Add scripts:

~~~json
{
  "preflight:portable": "node scripts/preflight-portable.mjs",
  "verify:release": "node scripts/verify-release.mjs"
}
~~~

- [ ] **Step 4: Verify GREEN**

~~~bash
npm test -- tests/preflight-portable.test.ts tests/verify-release.test.ts
node scripts/preflight-portable.mjs --h3-env-file .env.example
npm run verify:release
~~~

Expected: all PASS; preflight validates the example; release scan reports no forbidden tracked source.

- [ ] **Step 5: Commit**

~~~bash
git add package.json scripts tests
git commit -m "build: add portable release verification"
~~~

### Task 4: Write the complete migration and operations guide

**Files:**
- Modify: README.md
- Create: docs/getting-started.md
- Create: docs/deployment-gb10.md
- Create: docs/architecture.md
- Create: docs/optimization-guide.md
- Create: docs/model-and-node-manifest.md
- Create: docs/upscale.md
- Create: docs/troubleshooting.md
- Create: docs/security-and-secrets.md
- Create: tests/documentation-contract.test.ts

**Interfaces:**
- Consumes: existing optimization guide, worker contracts and Task 2/3 commands.
- Produces: newcomer-facing documentation linked from README.

- [ ] **Step 1: Write the failing documentation test**

~~~ts
const docs = [
  'docs/getting-started.md',
  'docs/deployment-gb10.md',
  'docs/architecture.md',
  'docs/optimization-guide.md',
  'docs/model-and-node-manifest.md',
  'docs/upscale.md',
  'docs/troubleshooting.md',
  'docs/security-and-secrets.md',
];

it('links migration docs from README without active-machine paths or tokens', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const doc of docs) expect(readme).toContain(doc);
  expect(readme).not.toMatch(/\/home\/[A-Za-z0-9_-]+\//);
  expect(readme).not.toMatch(/ghp_[A-Za-z0-9]+/);
});
~~~

- [ ] **Step 2: Confirm RED**

Run: npm test -- tests/documentation-contract.test.ts

Expected: FAIL because README has active-machine paths and no migration-document index.

- [ ] **Step 3: Write docs**

README: capability matrix, requirements, quick start, preflight/deploy entrypoints, documentation index, model/secrets boundary.

getting-started: clone, .env creation, npm ci, local UI, SSH tunnel and health.

deployment-gb10: GB10 prerequisites, directory layout, compose lifecycle, custom-node install, upgrades/rollback.

architecture: browser, BFF, ComfyUI and worker port/data boundaries.

optimization-guide: Standard, FastH3 VSA, Music3, mutual exclusions and performance/quality discipline. Reuse validated content from the current guide.

model-and-node-manifest: external model/node semantics, licensing boundary, checksums and gates.

upscale: RealESRGAN 480P/720P profiles, history UI, cancellation, audio/frame preservation and FlashVSR gate.

troubleshooting: health, ComfyUI, capability, GPU, worker and media commands.

security-and-secrets: ignore policy, Cloudflare template, loopback access and GitHub device login.

- [ ] **Step 4: Verify GREEN**

~~~bash
npm test -- tests/documentation-contract.test.ts
rg -n '/home/[A-Za-z0-9_-]+/|ghp_[A-Za-z0-9]+' README.md docs/getting-started.md docs/deployment-gb10.md docs/architecture.md docs/optimization-guide.md docs/model-and-node-manifest.md docs/upscale.md docs/troubleshooting.md docs/security-and-secrets.md || true
~~~

Expected: test PASS and no active-machine path or token in user-facing docs.

- [ ] **Step 5: Commit**

~~~bash
git add README.md docs tests/documentation-contract.test.ts
git commit -m "docs: add portable H3 Studio operating guide"
~~~

### Task 5: Final validation, GitHub publication and clean clone

**Files:**
- Modify: Git metadata only

**Interfaces:**
- Consumes: completed repository and local identity Xiaoffy <xiaofei_66@icloud.com>.
- Produces: pushed private main branch and verified clean clone.

- [ ] **Step 1: Commit approved design/plan records**

~~~bash
git add docs/superpowers/specs/2026-09-03-h3-studio-portable-github-design.md
git add -f docs/superpowers/plans/2026-09-03-h3-studio-portable-github.md
git commit -m "docs: record portable repository plan"
~~~

- [ ] **Step 2: Run release-grade checks**

~~~bash
npm test
npm run check
npm run build
node scripts/preflight-portable.mjs --h3-env-file .env.example
npm run verify:release
git diff --check main
git status --short
~~~

Expected: all checks exit zero, no secret/model/output is tracked and the working tree is clean apart from ignored local configuration.

- [ ] **Step 3: Authenticate without a pasted token**

Install GitHub CLI if absent, then use:

~~~bash
gh auth login --web --git-protocol https
gh auth status
~~~

The user approves the device flow in a browser. Never put a PAT in chat, shell history, source or documentation.

- [ ] **Step 4: Create and push private remote**

After gh auth status confirms Xiaofei-fei:

~~~bash
gh repo create Xiaofei-fei/h3-studio-gb10 --private --source=. --remote=origin --push
~~~

If created in the browser instead, use git remote add origin followed by git push -u origin main.

- [ ] **Step 5: Verify a clean clone**

~~~bash
clone_dir=$(mktemp -d)
git clone --depth 1 "$(git remote get-url origin)" "$clone_dir/h3-studio-gb10"
cd "$clone_dir/h3-studio-gb10"
npm ci
npm run check
node scripts/preflight-portable.mjs --h3-env-file .env.example
~~~

Expected: a new clone passes source/type/config preflight. GB10 inference remains a destination-machine test because models/nodes are external prerequisites.
