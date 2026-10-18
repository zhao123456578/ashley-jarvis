<div align="center">
  <h1>Ashley Jarvis</h1>
  <p><strong>A real-time voice desktop assistant for Windows — with a Jarvis-style 3D helmet.</strong></p>
  <p>实时语音桌面助手 · 本地唤醒词 · 声纹识别 · 豆包全双工语音 · 3D 头盔拼装动效</p>
</div>

> 本仓库是 [Cw-JackMMXX/ashley-desktop-assistant-win](https://github.com/Cw-JackMMXX/ashley-desktop-assistant-win)
> 的二次开发版（MIT 许可）。**原作者：Cw-JackMMXX**。本版把形象换成了蓝色贾维斯头盔，
> 并补充了中文使用文档。上游文档保留在 [README-upstream.md](README-upstream.md)。

## 本版与上游的差异

**目前没有改动任何代码和素材，与上游保持一致。** 本仓库存在的目的是：

- 提供一个中文说明完整、可以直接上手参与的镜像；
- 后续的形象、语音、动作等改动，都在 Issues / PR 里公开讨论。

上游是 MIT 协议，欢迎任何人直接开 PR。想换形象的话，改 `assets/helmet/model.glb` 就能换
（渲染器是 `unlit` 模式，直接显示贴图；模型自带的 63 块拼装、4 万粒子、全息效果都会保留）。

## 它有什么能力

| 能力 | 说明 |
| --- | --- |
| **本地唤醒词** | 喊「Hey Jarvis」唤醒，全本地 ONNX 推理，不外传 |
| **声纹识别** | sherpa-onnx 说话人识别，只认注册过的声音 |
| **豆包全双工语音** | 实时 ASR + LLM + TTS，可边听边说、可打断 |
| **3D 头盔** | three.js + GLB，63 块装甲拼装、4 万粒子、待机张望、全息模式 |
| **语音动作** | 打开应用 / 打开网址 / 搜索网页 / 查天气 / 播放音乐 |
| **窗口感知** | 检测前台窗口，说完自动停靠避让 |

## 快速开始

需要 **Node.js 18+** 和 **pnpm**。

```powershell
pnpm install
pnpm run build      # 编译主进程 + 渲染进程
pnpm run dev        # 编译后直接启动
```

打包 Windows 安装程序：

```powershell
pnpm run package:win
```

### 配置语音（必须）

在项目根目录建 `.env`（**已被 .gitignore 排除，不会进仓库**）：

```ini
JARVIS_VOICE_PROVIDER=doubao
DOUBAO_APP_ID=你的 App ID
DOUBAO_API_KEY=你的 API Key
DOUBAO_RESOURCE_ID=volc.speech.dialog
```

豆包实时语音需要在火山引擎控制台开通「实时对话」能力。没有 Key 时语音链路不可用，界面仍可打开。

### 声纹注册

首次启动会引导录入唤醒词/声纹。注意 `.gitignore` 里明确排除了 `personal-wake-model.json`、
`recordings/`、`voice-training/`、`assets/wake-word/models/ashley.onnx` ——
**这些是用你自己的声音训练出来的，绝对不要提交到公开仓库。**

## 目录结构

```text
ashley-jarvis/
├── src/main/          Electron 主进程（窗口、托盘、豆包传输、天气）
├── src/renderer/      three.js 头盔渲染、语音链路、唤醒词、声纹
├── src/native/        Windows 窗口状态脚本
├── assets/helmet/     model.glb（本版已换成蓝盔）
├── assets/wake-word/  本地唤醒词模型（ONNX）
├── assets/speaker-verify/  声纹模型
├── scripts/           构建与资源处理
└── docs/              上游文档
```

## 授权

**MIT License**，见 [LICENSE](LICENSE)。

本仓库保留了上游的版权声明。按 MIT 的要求，任何人可以自由使用、修改、再发布，
但**必须保留版权声明和许可证文本**。如果你基于本仓库继续改，也请注明来自
[Cw-JackMMXX/ashley-desktop-assistant-win](https://github.com/Cw-JackMMXX/ashley-desktop-assistant-win)。

第三方组件（Electron、three.js、sherpa-onnx、onnxruntime-web、openWakeWord 等）
各自的许可证见其 `node_modules` 内附带的 LICENSE 文件。

## English

A mirror/fork of [Cw-JackMMXX/ashley-desktop-assistant-win](https://github.com/Cw-JackMMXX/ashley-desktop-assistant-win)
(MIT) with Chinese documentation. **Code and assets currently match upstream — no changes.**
Pull requests are welcome; swapping the avatar only requires replacing `assets/helmet/model.glb`.

```powershell
pnpm install
pnpm run build
pnpm run dev
```

Create a `.env` with your Doubao (Volcengine) realtime-voice credentials to enable the voice pipeline.
Never commit `.env`, personal wake-word models, or voice recordings.
