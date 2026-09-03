# 安全与凭据

本仓库的安全边界很简单：源码可以迁移，模型、运行数据和凭据不能随源码迁移。

## 不应进入 Git 的内容

`.gitignore` 已覆盖以下类别：

- `.env`、私有 secrets、Cloudflare 实例配置和本地 agent 状态；
- H3 / Music3 / LoRA / VAE / RealESRGAN 等模型权重；
- ComfyUI input/output、增强输出、worker 状态、虚拟环境、wheelhouse、下载缓存和构建产物；
- Python 缓存、Node 依赖与浏览器测试临时文件。

唯一可提交的环境配置是 `.env.example`。它只能包含可替换的路径和别名，不能包含密码、访问密钥、隧道令牌或签名下载链接。

## 发布前安全门

```bash
npm run verify:release
git status --short
```

发布扫描基于 Git 已跟踪文件，阻止权重扩展名、运行目录、私有 Cloudflare 配置和常见令牌格式。它只输出文件名和原因，不回显文件内容或凭据值。扫描通过不替代人工检查：提交前仍应确认 `.env`、模型、输出和缓存没有被暂存。

## GitHub 操作

使用 GitHub CLI 时，采用浏览器设备登录，不要把访问令牌粘贴到命令行、聊天、文档或仓库：

```bash
gh auth login --web --git-protocol https
gh auth status
```

创建远端时优先使用私有仓库。推送前执行测试、构建、预检和发布扫描；推送后从干净目录 clone 并再次运行 `npm ci`、`npm run check` 和预检。

## Cloudflare（可选）

Cloudflare Worker 仅代理 H3 Studio BFF，不托管模型或前端构建。使用 `cloudflare-worker/wrangler.jsonc.example` 创建本地 `wrangler.jsonc`，将实际 VPC service 标识和 Cloudflare 认证信息保留在部署机。实际 `wrangler.jsonc` 已被忽略。

隧道令牌仅放在 GB10 的 `.secrets/cloudflared.env`，权限应限制为服务账户可读。H3 Studio、ComfyUI 和增强 worker 继续绑定 loopback；若要从外部访问，使用 Cloudflare Access 或组织认可的等效访问控制，而不是直接开放推理端口。

## 日常原则

1. 先验证模型 hash，再让服务扫描模型。
2. 部署前保持 ComfyUI 队列为空，避免节点更新中断任务。
3. 不在日志、截图或 issue 中贴出完整配置文件、下载链接或服务标识。
4. 发生疑似泄露时，先撤销凭据、更新本地配置、运行发布扫描，再审查 Git 历史与远端访问记录。
