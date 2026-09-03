# 系统架构

H3 Studio 将控制面与推理面分离：浏览器只与 BFF 通信，BFF 通过本机网络或 SSH 隧道访问 ComfyUI 与增强 worker。模型权重始终留在推理机。

```text
Browser
  │  HTTP / SSE
  ▼
H3 Studio BFF :5174 (loopback)
  ├─ HTTP + WebSocket → ComfyUI :8188 (loopback or SSH tunnel)
  ├─ HTTP → FlashVSR worker :8190 (loopback)
  └─ HTTP → RealESRGAN worker :8191 (loopback)
                                │
                                ▼
                    ComfyUI output / worker state / models
```

## 组件职责

| 组件 | 职责 | 不负责什么 |
| --- | --- | --- |
| React/Vite 前端 | 表单、模式切换、能力展示、真实进度、历史记录与增强入口 | 不直接加载模型或访问 ComfyUI 文件系统。 |
| Node.js BFF | 参数规范化、workflow 组装、ComfyUI capability 探测、排队状态、取消、媒体代理 | 不执行 DiT/VAE 推理。 |
| ComfyUI | H3 Standard、FastH3、Music3 workflow，模型加载与媒体写入 | 不对浏览器开放公共端口。 |
| TAEH3 节点 | 可选实时预览解码 | 不改变最终视频 VAE 的保存结果。 |
| FlashVSR worker | 通过 gate 后的离线高质量视频增强 | gate 未通过时不接收任务。 |
| RealESRGAN worker | 已验证规格上的确定性 x2/2K 增强 | 不支持任意分辨率或 Music3 输出。 |
| 可选 Cloudflare 网关 | 经 Access 和私有隧道代理 BFF | 不托管模型、前端构建或 ComfyUI。 |

## 请求生命周期

1. 前端提交生成参数或参考素材。
2. BFF 校验模式、时长、分辨率、步数、互斥优化项和文件名；随后再次检查 ComfyUI 节点能力。
3. BFF 生成 ComfyUI workflow，提交队列并订阅 WebSocket 事件。
4. BFF 将队列、准备、去噪、解码和保存状态转为浏览器可消费的 SSE 更新。
5. 完成后，BFF 仅通过安全的 output 引用代理媒体；浏览器不拥有任意文件路径访问能力。
6. 生成完成的 H3 视频可再创建独立增强任务；增强状态与生成任务分开管理。

## 端口与访问边界

| 端口 | 服务 | 推荐访问范围 |
| --- | --- | --- |
| 5174 | H3 Studio BFF | 仅 loopback；需要远程访问时通过受控隧道。 |
| 8188 | ComfyUI | 仅 GB10 loopback，或由开发机 SSH 隧道映射。 |
| 8190 | FlashVSR worker | 仅 GB10 loopback，由 BFF 调用。 |
| 8191 | RealESRGAN worker | 仅 GB10 loopback，由 BFF 调用。 |

Docker Compose 使用 host networking 以连接既有 ComfyUI，但没有为这些服务新增公网 `ports` 映射。可选 Cloudflare 配置也只建立出站隧道，细节见[安全与凭据](security-and-secrets.md)。

## 失败隔离

- ComfyUI 不可达时，BFF 报告 `connected: false`，不会伪造可用性。
- 节点、LoRA 或模型缺失时，相关开关显示不可用并给出原因。
- FlashVSR 的源码、运行时、模型或小型推理 gate 失败时，主服务继续运行，FlashVSR 被标为不可用。
- RealESRGAN 在模型哈希不匹配或规格不支持时拒绝任务。
- 取消任务使用 ComfyUI 队列/中断接口或 worker 自身的取消状态，不通过终止整机 GPU 进程实现。

这使 Standard、FastH3、Music3 和增强功能能独立降级，便于定位问题和控制影响范围。
