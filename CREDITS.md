# 来源与授权

## 上游项目

**[Cw-JackMMXX/ashley-desktop-assistant-win](https://github.com/Cw-JackMMXX/ashley-desktop-assistant-win) — MIT License**

本仓库的绝大部分代码来自该项目：Electron 主进程、three.js 头盔渲染、豆包全双工语音链路、
本地唤醒词（openWakeWord / sherpa-onnx KWS）、声纹识别、语音动作、窗口感知等。

上游许可证原文见 [LICENSE](LICENSE)（`Copyright (c) 2026 Jarvis Contributors`），
上游说明文档见 [README-upstream.md](README-upstream.md)。

## 本版改动

| 文件 | 改动 |
| --- | --- |
| `assets/helmet/model.glb` | 贴图重映射：把原模型贴图里的金色部分（暖色高光）映射成蓝色辉光，暗部保留炭黑。网格、UV、动画、材质结构均未改动 |

也就是说：**这是一次纯外观改动**，没有修改任何逻辑代码。

## 第三方组件

下列组件通过 npm 安装，不随源码分发，各自的许可证见其包内 LICENSE：

- **Electron**（MIT / Chromium BSD-style）
- **three.js**（MIT）
- **sherpa-onnx** / **sherpa-onnx-node**（Apache-2.0）
- **onnxruntime-web**（MIT）
- **openwakeword-wasm-browser**（Apache-2.0）
- **ws**（MIT）、**dotenv**（BSD-2-Clause）

## 素材说明

`assets/helmet/model.glb` 是由 AI 3D 生成服务（Tripo）产出的模型，随后用 glTF-Transform 处理。
**本仓库以 MIT 重新分发该文件存在授权不确定性**——如果你要商用或大规模分发，
建议先确认原始生成服务的条款，或替换成自己有明确授权的模型。

`assets/speaker-verify/`、`assets/wake-word/` 下的模型分别来自 sherpa-onnx 和
openWakeWord 生态，保留其原始许可。
