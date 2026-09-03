# 开始使用

本页说明如何在开发机运行界面，并通过 SSH 隧道连接 GB10 上的 ComfyUI。它不下载模型，也不修改 GB10。

## 1. 准备源码

```bash
git clone <repository-url>
cd h3-studio-gb10
npm ci
npm test
npm run check
```

前端和 BFF 可在没有模型的机器上构建、测试。真正提交视频/音乐任务前，仍需要可访问的 ComfyUI 和完整的外部模型、节点。

## 2. 建立开发隧道

如果 H3 Studio 在开发机上运行，而 ComfyUI 在 GB10 上运行：

```bash
ssh -N -L 8188:127.0.0.1:8188 <gb10-ssh-alias>
```

保持这个终端窗口开启。另开一个终端启动开发服务：

```bash
npm run dev
```

- 界面：`http://127.0.0.1:5173`
- 本地 API：`http://127.0.0.1:5174`
- 隧道后的 ComfyUI：`http://127.0.0.1:8188`

生产运行可使用 `npm run build && npm run start`，BFF 默认仍只监听 `127.0.0.1:5174`。

## 3. 做健康检查

```bash
curl http://127.0.0.1:8188/system_stats
curl http://127.0.0.1:5174/api/health
```

第二个响应中的 `connected: true` 表示 BFF 已连通 ComfyUI。`services` 会逐项说明 FastH3、参考输入、TAEH3 预览、INT8、Music3 与增强 worker 是否可用，以及不可用的原因。

不要仅凭界面开关判断优化是否生效：H3 Studio 会在提交前再次检查远端 capability；缺少节点或模型时请求会被拒绝，而不是静默回退。

## 4. 选择模式

| 模式 | 适合什么场景 | 使用限制 |
| --- | --- | --- |
| H3 Standard | 常规成片、质量基线、逐项 A/B | 支持文本、关键帧和多模态参考；步数由界面控制。 |
| FastH3 VSA | 低延迟预览 | 固定为 4-step Euler，只支持纯文本视频。 |
| MiniMax Music3 | 音乐生成 | 只支持文本；视频参考控件不会进入该工作流。 |

建议先用 H3 Standard 稠密路径建立质量参考，再一次启用一个优化。FastH3 是独立的低步数路径，不应与 Standard 的缓存或 Sparge 结果混作单一内核对比。详细说明见[推理优化](optimization-guide.md)。

## 5. 停止与关闭

- 点击生成面板的停止按钮会向 BFF 发出取消请求，再由 BFF 从 ComfyUI 队列移除任务或请求中断正在执行的任务。
- 关闭开发进程只会停止 H3 Studio；SSH 隧道要在它自己的终端中用 `Ctrl+C` 关闭。
- 增强任务有独立的停止按钮和状态，不会通过强制结束 GPU 进程来取消。

若任务不能停止或界面没有连通性，按[故障排查](troubleshooting.md)中的顺序检查；不要在仍有任务运行时重启 ComfyUI。
