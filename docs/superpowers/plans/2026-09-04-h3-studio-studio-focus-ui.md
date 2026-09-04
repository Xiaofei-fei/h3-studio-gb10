# H3 Studio Studio Focus UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 H3 Studio 创作页，使提示词与生成成为主路径，并将输入模式、运行参数和精细设置按需折叠，同时将 TAEH3 实时预览移入右侧结果面。

**Architecture:** 保持 `GenerationForm`、BFF、ComfyUI 工作流和历史数据不变；仅在 React 组合层新增展示状态，并用一个受控的 `DisclosureSection` 统一折叠交互。`GenerationControls` 管理运行参数和高级设置，`GenerationPanel` 接收最小的 TAEH3 显示/变更 props 并将开关定位于预览工具栏。

**Tech Stack:** React 19、TypeScript、Vite、Vitest、Testing Library、现有 CSS。

**Spec:** `docs/superpowers/specs/2026-09-04-h3-studio-studio-focus-design.md`

## Global Constraints

- 不修改任何 ComfyUI 工作流、服务端 API、`GenerationForm` 请求字段或历史/超分格式。
- FastH3 VSA 继续固定 832 × 480；H3 Standard 继续使用现有兼容画幅；Music3 继续沿用其专有设置。
- 折叠只能影响可见性，不能卸载已上传素材、重置表单值或隐藏当前服务/画幅/时长摘要。
- TAEH3 仅在 H3 Standard 且 `services.taeH3Preview.available === true` 时可操作。
- UI 使用深色令牌 `#0B0D12` / `#131720`、暖金主强调 `#E3C77A`、12px 圆角、44px 最小触控目标；不加载在线字体。
- 所有披露按钮都有可见焦点、`aria-expanded`、`aria-controls` 与文本标签；`prefers-reduced-motion` 下不播放非必要动效。
- 不触碰仓库中与本计划无关的已修改/未跟踪文件。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/components/DisclosureSection.tsx` | 受控、可访问的参数摘要/展开容器与统一 chevron 图标 |
| `src/App.tsx` | 创作页组合、输入模式摘要、输入条件披露状态、向参数/预览传递受控 props |
| `src/components/GenerationControls.tsx` | 服务、画幅、时长的“运行参数”披露区；保留精细设置逻辑 |
| `src/components/GenerationPanel.tsx` | 预览工具栏、TAEH3 紧凑开关与更克制的空状态结构 |
| `src/styles.css` | Studio Focus 令牌、双栏工作区、披露行、预览工具栏、移动端和减少动效规则 |
| `tests/disclosure-section.test.tsx` | 披露控件的语义和键盘/点击状态 |
| `tests/app-ui.test.tsx` | App 输入模式与运行参数默认收起、展开、表单值持续性 |
| `tests/generation-panel.test.tsx` | TAEH3 预览工具栏的显示、禁用与回调 |

## Task 1: 创建可访问的 DisclosureSection 基元

**Files:**
- Create: `src/components/DisclosureSection.tsx`
- Create: `tests/disclosure-section.test.tsx`

**Interfaces:**
- Consumes: React `ReactNode`、受控 `open` 状态。
- Produces: `DisclosureSection({ id, label, summary, icon, open, onOpenChange, children, className? })`；所有后续参数区使用它。

- [ ] **Step 1: 写出失败的披露交互测试**

```tsx
it('publishes its summary and toggles the controlled content accessibly', async () => {
  const user = userEvent.setup();
  function Fixture() {
    const [open, setOpen] = useState(false);
    return <DisclosureSection id="runtime" label="运行参数" summary="H3 Standard · 5 秒" open={open} onOpenChange={setOpen}><p>服务选择</p></DisclosureSection>;
  }
  render(<Fixture />);
  const trigger = screen.getByRole('button', { name: /运行参数.*H3 Standard.*5 秒/ });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('服务选择')).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/disclosure-section.test.tsx`

Expected: FAIL，提示 `DisclosureSection` 模块尚不存在。

- [ ] **Step 3: 实现最小受控组件**

```tsx
export interface DisclosureSectionProps {
  id: string;
  label: string;
  summary: ReactNode;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}

export function DisclosureSection({ id, label, summary, icon, open, onOpenChange, children, className }: DisclosureSectionProps) {
  const contentId = `${id}-content`;
  return <section className={`disclosure-section ${open ? 'is-open' : ''} ${className || ''}`.trim()}>
    <button type="button" className="disclosure-trigger" aria-expanded={open} aria-controls={contentId} onClick={() => onOpenChange(!open)}>
      {icon && <span className="disclosure-icon" aria-hidden="true">{icon}</span>}
      <span className="disclosure-copy"><strong>{label}</strong><small>{summary}</small></span>
      <ChevronIcon />
    </button>
    <div id={contentId} className="disclosure-content" hidden={!open}>{children}</div>
  </section>;
}
```

`ChevronIcon` 必须是内联 SVG，`viewBox="0 0 24 24"`、圆角 1.5px 描边、`currentColor`，而非 `⌄` 字符。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/disclosure-section.test.tsx`

Expected: PASS，`aria-expanded` 从 `false` 切换为 `true`，内容出现。

- [ ] **Step 5: 提交基元**

```bash
git add src/components/DisclosureSection.tsx tests/disclosure-section.test.tsx
git commit -m "feat: add accessible disclosure section"
```

## Task 2: 将视频输入模式收进条件披露区

**Files:**
- Modify: `src/App.tsx:1-330`
- Modify: `tests/app-ui.test.tsx:30-420`

**Interfaces:**
- Consumes: Task 1 的 `DisclosureSection`、现有 `GenerationForm.inputMode`、`ReferenceInputs`、`ReferenceCapability`。
- Produces: `inputModeOpen` 展示状态、`inputModeSummary(form)` 推导摘要，以及 `runSettingsOpen` 传递给 `GenerationControls`。

- [ ] **Step 1: 写出默认收起、切换自动展开和素材保留的失败测试**

```tsx
it('keeps input conditions compact until selected, then keeps uploaded keyframes after collapse', async () => {
  const user = userEvent.setup();
  render(<App api={api} />);
  const inputTrigger = screen.getByRole('button', { name: /视频输入模式.*纯文本/ });
  expect(inputTrigger).toHaveAttribute('aria-expanded', 'false');
  await user.click(inputTrigger);
  await user.click(screen.getByRole('button', { name: '首尾帧' }));
  expect(inputTrigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('首帧（必填）')).toBeVisible();
});
```

补充一个已有首帧的 `GenerationForm` fixture：在上传/选择首帧后收起区域，断言摘要匹配 `/首尾帧.*1 张素材/`，再次展开后首帧文件名仍存在。

- [ ] **Step 2: 运行 App UI 测试确认失败**

Run: `npm test -- tests/app-ui.test.tsx -t "input conditions compact"`

Expected: FAIL，当前页面没有“视频输入模式”披露触发器。

- [ ] **Step 3: 在 App 中加入受控展示状态与摘要推导**

```tsx
const [inputModeOpen, setInputModeOpen] = useState(false);
const [runSettingsOpen, setRunSettingsOpen] = useState(false);

const inputModeSummary = form.inputMode === 'keyframes'
  ? `首尾帧 · ${Number(Boolean(form.firstFrame)) + Number(Boolean(form.lastFrame))} 张素材`
  : form.inputMode === 'references'
    ? `多模态参考 · ${form.referenceImages.length + form.referenceVideos.length + form.referenceAudios.length} 项`
    : '纯文本';

const selectInputMode = (inputMode: GenerationForm['inputMode']) => {
  patchForm({ inputMode });
  if (inputMode !== 'text') setInputModeOpen(true);
};
```

用 `DisclosureSection` 包住现有的模式按钮、能力错误和 `ReferenceInputs`。只将 `ReferenceInputs` 放在披露内容内，不改变其 props；将 `onClick={() => patchForm(...)}` 改为 `selectInputMode(...)`。

同时移除 `page-glow`、大 Hero/kicker 与 `private-chip` 的 JSX，替换为简短的 `studio-intro`：`<h1>创建视频</h1>` 和一行说明；保留 topbar 的真实连接状态。

- [ ] **Step 4: 运行相关测试确认通过**

Run: `npm test -- tests/app-ui.test.tsx -t "input conditions compact|keyframe|reference"`

Expected: PASS，三种输入模式仍可选择；非纯文本模式自动展开；上传素材不会因收起而丢失。

- [ ] **Step 5: 提交创作条件重组**

```bash
git add src/App.tsx tests/app-ui.test.tsx
git commit -m "feat: collapse H3 input conditions"
```

## Task 3: 将服务、画幅与时长收进运行参数披露区

**Files:**
- Modify: `src/components/GenerationControls.tsx:1-846`
- Modify: `src/App.tsx:282-288`
- Modify: `tests/app-ui.test.tsx:30-420`

**Interfaces:**
- Consumes: Task 1 的 `DisclosureSection` 和 Task 2 的 `runSettingsOpen` / `setRunSettingsOpen`。
- Produces: `GenerationControlsProps` 新增 `runSettingsOpen: boolean` 与 `onToggleRunSettings: () => void`，并持续调用现有 `onChange(patch)`。

- [ ] **Step 1: 写出运行参数摘要与展开后的兼容预设测试**

```tsx
it('hides service and canvas controls behind a truthful runtime summary', async () => {
  const user = userEvent.setup();
  render(<App api={api} />);
  const runtime = screen.getByRole('button', { name: /运行参数.*H3 Standard.*1344.*768/ });
  expect(runtime).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: /竖屏 9:16/ })).toBeNull();
  await user.click(runtime);
  await user.click(screen.getByRole('button', { name: /竖屏 9:16/ }));
  expect(runtime).toHaveTextContent(/576.*1024/);
});
```

保留并调整现有 FastH3 测试：展开后只出现 `480P 832 × 480`，服务切换仍强制 4-step Euler 和纯文本模式。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/app-ui.test.tsx -t "truthful runtime summary"`

Expected: FAIL，当前服务和画幅控件初始可见，且没有运行参数摘要。

- [ ] **Step 3: 重组 GenerationControls**

```tsx
export interface GenerationControlsProps {
  form: GenerationForm;
  services?: ComfyServiceCapabilities;
  showAdvanced: boolean;
  runSettingsOpen: boolean;
  onChange: (patch: Partial<GenerationForm>) => void;
  onToggleAdvanced: () => void;
  onToggleRunSettings: () => void;
}

const runtimeSummary = isMusic3
  ? `MiniMax Music3 · ${form.seconds} 秒`
  : `${isFastH3 ? 'FastH3 VSA' : 'H3 Standard'} · ${form.width} × ${form.height} · ${form.seconds} 秒 · ${advancedSummary}`;
```

将现有“推理服务”“输出画幅”“视频时长”节点原样移入 `DisclosureSection id="run-settings"`。服务能力原因、H3 画幅提示、时长滑块、Music3 控件保留在披露内容；不更改 `resolutionPresets`、`actualFrameLength`、服务切换或优化布尔值的任何逻辑。

`精细设置` 继续使用既有状态，但其触发器视觉更新为与 `DisclosureSection` 一致的摘要行；它不是“运行参数”的子区域，避免嵌套复杂度。

- [ ] **Step 4: 运行相关测试确认通过**

Run: `npm test -- tests/app-ui.test.tsx -t "runtime summary|FastH3|H3-compatible|duration|cuBLAS|AdaGEMM"`

Expected: PASS，服务、画幅、时长和优化提交数据保持原行为。

- [ ] **Step 5: 提交运行参数重组**

```bash
git add src/App.tsx src/components/GenerationControls.tsx tests/app-ui.test.tsx
git commit -m "feat: group H3 runtime controls"
```

## Task 4: 将 TAEH3 开关移至预览工具栏

**Files:**
- Modify: `src/App.tsx:296-311`
- Modify: `src/components/GenerationControls.tsx:85-109, 713-714`
- Modify: `src/components/GenerationPanel.tsx:13-381`
- Modify: `tests/generation-panel.test.tsx:1-460`
- Modify: `tests/app-ui.test.tsx:30-420`

**Interfaces:**
- Consumes: `form.service`、`form.taeH3Preview`、`connection.services?.taeH3Preview` 与 Task 2 的 `patchForm`。
- Produces: `GenerationPanelProps.taeH3Preview?: boolean`、`taeH3PreviewCapability?: ServiceCapability`、`onTaeH3PreviewChange?: (enabled: boolean) => void`。

- [ ] **Step 1: 写出预览区开关的失败测试**

```tsx
it('places the available TAEH3 switch in the preview toolbar and emits its next value', async () => {
  const user = userEvent.setup();
  const onTaeH3PreviewChange = vi.fn();
  render(<GenerationPanel job={null} api={api} onRetry={vi.fn()} taeH3Preview={false}
    taeH3PreviewCapability={{ available: true }} onTaeH3PreviewChange={onTaeH3PreviewChange} />);
  const toggle = screen.getByRole('switch', { name: 'TAEH3 实时预览' });
  expect(toggle).toBeVisible();
  await user.click(toggle);
  expect(onTaeH3PreviewChange).toHaveBeenCalledWith(true);
});
```

再添加一个断言：`taeH3PreviewCapability={{ available: false }}` 或 Music3 上下文时没有可操作开关，且不可用原因可读。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/generation-panel.test.tsx -t "TAEH3 switch"`

Expected: FAIL，`GenerationPanelProps` 尚未定义这组 props。

- [ ] **Step 3: 实现预览工具栏**

```tsx
const showTaePreviewControl = Boolean(taeH3PreviewCapability?.available && onTaeH3PreviewChange);
const previewToolbar = <div className="preview-toolbar">
  <span>实时预览</span>
  {showTaePreviewControl && <button type="button" role="switch" aria-checked={taeH3Preview}
    aria-label="TAEH3 实时预览" onClick={() => onTaeH3PreviewChange?.(!taeH3Preview)}><span />TAEH3</button>}
  {!showTaePreviewControl && taeH3PreviewCapability?.reason && <small>{taeH3PreviewCapability.reason}</small>}
</div>;
```

在 idle、progress、completed、failed 和 cancelled 分支的 `generation-panel` 内以同一位置渲染 `previewToolbar`。用 `isH3Standard` 从 App 决定是否传入 capability/callback；从 `GenerationControls` 删除大块 `TAEH3PreviewToggle`，但不删除 `taeH3Preview` 表单字段。

将 idle 的 `ambient-sphere`、`ambient-grid` 和巨大 `H3` 字样替换为小型、静态的 `preview-empty-state`，避免持续装饰动画。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- tests/generation-panel.test.tsx tests/app-ui.test.tsx -t "TAEH3|实时预览"`

Expected: PASS，开关位于预览区并正确写回 `GenerationForm`；进度预览图片和“非最终画质”文字仍可见。

- [ ] **Step 5: 提交预览工具栏迁移**

```bash
git add src/App.tsx src/components/GenerationControls.tsx src/components/GenerationPanel.tsx tests/generation-panel.test.tsx tests/app-ui.test.tsx
git commit -m "feat: move TAEH3 control to preview toolbar"
```

## Task 5: 应用 Studio Focus 视觉系统与响应式布局

**Files:**
- Modify: `src/styles.css:1-556`
- Modify: `src/App.tsx:196-329`
- Modify: `src/components/GenerationPanel.tsx:189-381`
- Modify: `tests/app-ui.test.tsx:30-420`

**Interfaces:**
- Consumes: Tasks 1–4 的 class names 与 DOM 层级。
- Produces: 在 1440px、900px、600px、390px 下稳定的布局；不会改变组件 props 或 API。

- [ ] **Step 1: 写出结构性 UI 测试**

```tsx
it('keeps a single primary generation action while secondary controls remain disclosures', () => {
  render(<App api={api} />);
  expect(screen.getAllByRole('button', { name: '生成视频' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: /视频输入模式/ })).toHaveClass('disclosure-trigger');
  expect(screen.getByRole('button', { name: /运行参数/ })).toHaveClass('disclosure-trigger');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- tests/app-ui.test.tsx -t "single primary generation action"`

Expected: FAIL，当前 DOM 没有新的披露触发器 class。

- [ ] **Step 3: 用集中令牌替换首屏样式并增加响应式规则**

在 `:root` 定义：

```css
--surface-canvas: #0b0d12;
--surface-raised: #131720;
--surface-hover: #1a1f2a;
--ink-strong: #f0f2f7;
--ink-muted: #94a0b5;
--accent-warm: #e3c77a;
--border-subtle: rgba(240, 242, 247, .12);
--radius-panel: 12px;
--motion-fast: 180ms;
--motion-panel: 240ms;
```

实现以下布局选择：

```css
.studio-grid { grid-template-columns: minmax(0, 1.62fr) minmax(360px, 1fr); gap: 24px; }
.creation-card, .generation-panel { border: 1px solid var(--border-subtle); border-radius: var(--radius-panel); background: var(--surface-raised); box-shadow: 0 18px 48px rgba(0, 0, 0, .16); }
.disclosure-trigger { min-height: 56px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; }
.preview-toolbar { min-height: 44px; display: flex; justify-content: space-between; align-items: center; }
@media (max-width: 900px) { .studio-grid { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .app-shell { padding: 16px; } .disclosure-trigger { min-height: 56px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
```

用独立的 `.disclosure-content`、`.preview-toolbar`、`.preview-empty-state`、`.studio-intro` 和 `.runtime-settings` class 组织样式；保持历史超分、视频播放、停止按钮和错误区域的现有选择器可用。去除/覆盖首屏巨型英雄、漂浮球体、网格和强玻璃拟态，不能只通过 `display:none` 掩盖关键内容。

- [ ] **Step 4: 运行结构测试与类型检查**

Run: `npm test -- tests/app-ui.test.tsx -t "single primary generation action" && npm run check`

Expected: PASS，且 TypeScript 无错误。

- [ ] **Step 5: 提交视觉系统**

```bash
git add src/App.tsx src/components/GenerationPanel.tsx src/styles.css tests/app-ui.test.tsx
git commit -m "style: refine H3 Studio creative workspace"
```

## Task 6: 全量回归、可视化 QA 与 GB10 部署

**Files:**
- Modify only if verification reveals a spec mismatch: `src/App.tsx`, `src/components/DisclosureSection.tsx`, `src/components/GenerationControls.tsx`, `src/components/GenerationPanel.tsx`, `src/styles.css`, corresponding tests.
- Do not modify: `server/**`, `workflows/**`, `realesrgan_worker/**`。

**Interfaces:**
- Consumes: Tasks 1–5 的完成版本与现有 GB10 Docker Compose 部署。
- Produces: 已验证的本地/GB10 UI 与仅包含本计划文件的最终提交。

- [ ] **Step 1: 运行完整前端回归与构建**

Run:

```bash
npm test -- tests/disclosure-section.test.tsx tests/app-ui.test.tsx tests/generation-panel.test.tsx tests/app.test.ts
npm run check
npm run build
```

Expected: 全部通过；若 `tests/app-ui.test.tsx` 中存在先前与本任务无关的重复文本定位失败，记录其完整名称，且不得通过降低断言或修改无关功能掩盖。

- [ ] **Step 2: 进行浏览器交互验证**

目标流程：`http://127.0.0.1:5174/` → 默认创作页 → 展开输入模式并选首尾帧 → 展开运行参数并选竖屏 9:16 → 关闭/打开 TAEH3 → 输入提示词 → 主按钮可用。

优先使用 Browser/IAB；若本环境 Browser CLI 不可用，使用已记录的 Edge CDP/Playwright 回退并记录原因。分别检查 1440 × 1024 和 390 × 844：页面标题、非空渲染、无框架错误遮罩、控制台无相关错误、无横向溢出、至少一次展开/选择/开关交互成功。

- [ ] **Step 3: 将修改同步并重建 GB10 前端容器**

Run from repository root:

```bash
rsync -aR --info=NAME ./src/App.tsx ./src/components/DisclosureSection.tsx ./src/components/GenerationControls.tsx ./src/components/GenerationPanel.tsx ./src/styles.css gb10:/home/lenovo/yuxf8/h3-studio/
ssh gb10 'cd /home/lenovo/yuxf8/h3-studio && docker compose -f docker-compose.gb10.yml build h3-studio && docker compose -f docker-compose.gb10.yml up -d --no-build h3-studio'
```

Expected: `h3-studio` 容器启动且 `curl -fsS http://127.0.0.1:5174/api/health` 返回可解析 JSON。

- [ ] **Step 4: 对照设计稿进行最终视觉验收**

打开并并排检查：

```bash
docs/design/h3-studio-ui-default-desktop-concept.png
docs/design/h3-studio-ui-keyframes-desktop-concept.png
docs/design/h3-studio-ui-mobile-concept.png
```

与新浏览器截图至少比较五项：顶部密度、62/38 工作区、折叠摘要、TAEH3 位置、主按钮层级、移动端无横向滚动。若任一项出现可见的设计审查问题，先修复再重复本步骤。

- [ ] **Step 5: 提交验证修复（仅有修复时）并报告**

```bash
git add src/App.tsx src/components/DisclosureSection.tsx src/components/GenerationControls.tsx src/components/GenerationPanel.tsx src/styles.css tests/disclosure-section.test.tsx tests/app-ui.test.tsx tests/generation-panel.test.tsx
git commit -m "fix: verify H3 Studio UI redesign"
```

若没有验收修复，不创建空提交。最终报告必须说明桌面/移动端视口、浏览器路径或回退原因、交互流程、构建命令、设计稿对比和仍存风险。
