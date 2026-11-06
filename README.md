# AI 面试模拟舱（ai-interview-coach）

纯本地运行的校招视频面试训练工具：把"AI 面试 / 录制式面试"搬回家练——读题、倒计时、一次录制不可重来、到时强停、追问连发、当场出报告，全部在无摄像头压力的环境里练成肌肉记忆。

录音、转写、评分、报告**全部留在本机**；发给大模型的只有题干与你的作答文字转写。

## 功能特性

- **三种平台模式**：北森式（三层追问、追问计分）、智联式（含文段朗读题）、前程无忧式（标准录制）——流程参数（准备/作答时长、是否追问、是否朗读）可在配置页覆盖
- **真实考试纪律**：设备自检（含试录 5 秒回听）→ 练习题 → 正式题；作答窗口内一次录制，无暂停、无重录、到时强停、放弃计零——练的就是"一遍成型"
- **AI 全流程参与**：
  - AI 出题官：按目标单位事实卡 + 你的历史弱项现场组卷
  - 教练提示：准备阶段显示答题提纲（真实考试没有，练习期可开）
  - 动态追问：基于你的作答转写生成针对性追问，逐层逼出具体事例、本人行动、结果数据
  - AI 教练总评：全场结束后生成整体评价与三条改进行动
- **数字面试官读题**：edge-tts 语音合成（离线时自动降级 Windows 本地语音）
- **本地语音转写**：faster-whisper（small/medium 可选，CPU int8 可跑），内置油气行业热词纠正，可自行增删
- **六项表达指标**：语速、长停顿次数、口头禅 Top3、逻辑连接词、时长达成率、结尾音量保持，外加朗读字准确率（中文字级、英文词级编辑距离）
- **内容评分**：任意 OpenAI 兼容网关（DeepSeek 官方 API 实测通过）——STAR 四要素打分、题干关键词命中、目标单位事实挂钩数、逐句点评、红线检测（负面表述识别 + 替换话术建议）
- **报告与趋势**：表达雷达图、历次总分趋势、越界警告、逐题转写与点评回看
- **素材库**：50+ 题内置题库（行为经历 / 求职动机 / 情境判断 / 中英文朗读 / 英语问答）、单位事实卡、STAR 故事登记、个人档案脱敏摘要（可选，用于生成简历深挖题）

## 架构

```
Electron 主进程（状态机 + 录制落盘 + ffmpeg 指标计算）
   │  行协议 JSON（stdin/stdout）
   ▼
Python 边车（常驻）
   ├─ tts_service    edge-tts / Windows SAPI 降级
   ├─ asr_service    faster-whisper（模型常驻，懒加载）
   └─ llm_service    OpenAI 兼容网关（json_mode + 重试）
渲染进程 React18 + zustand + echarts（MediaRecorder 分块录制经 IPC 落盘）
```

核心状态机在 `src/main/sessionMachine.ts`：18 个状态、deadline 差值法计时（抗系统睡眠）、非法迁移一律拒绝——渲染层只能展示，不能作弊。

## 环境要求

- Windows 10/11（macOS/Linux 理论可用，语音降级路径是 Windows 专属）
- Node.js 18+ 与 npm
- Python 3.10+（3.13 实测通过）
- ffmpeg 在 PATH（指标计算用）
- 磁盘：源码 + 依赖约 1GB，whisper 模型另需约 500MB

## 快速开始

```bash
# 1. 安装 Node 依赖（.npmrc 已配 npmmirror 镜像；海外网络可删掉 .npmrc）
npm install
# 若 Electron 二进制未自动下载（npm 11 常见），手动补一步：
#   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
#   node node_modules\electron\install.js

# 2. 安装 Python 边车依赖（edge-tts 必须 >=7.3.1，旧版令牌算法过期会 403）
pip install -r sidecar\requirements.txt

# 3. 预下载 whisper 模型（约 460MB，内置 hf-mirror 镜像）
python scripts\download-whisper-model.py small

# 4. 启动
npm run dev
```

首次使用进**设置页**填 LLM 网关（任意 OpenAI 兼容：base_url + api_key + 模型名），点连通测试即可。不配网关也能练：表达指标与转写照常出，仅内容评分与 AI 出题/追问/总评不可用。

## 数据与隐私

- 配置、录音、转写、报告全部在本机：`%APPDATA%\ai-interview-coach\`
- 网关密钥只存在本机 `gateway.json`，不进仓库、不随打包分发
- 发送到 LLM 网关的内容仅限：题干文本、你的作答文字转写、事实卡摘要——不含音频、不含其他本机数据
- 个人档案脱敏摘要功能默认关闭，构建后需人工审阅才会启用

## 打包

```bash
npm run build:win:nsis       # 安装版
npm run build:win:portable   # 便携版 ZIP
```

## 已知坑（实测记录）

- npm 11 不把 .npmrc 的 electron_mirror 传给安装脚本 → 用上面的手动下载命令
- huggingface 联网校验在代理下可能挂死 → 边车已做"本地有缓存即离线"，仅首次下载需要联网
- webm 录音文件无时长元数据属正常（MediaRecorder 特性），转写与指标不受影响
- 中文与全角括号源码路径实测可用；若你的打包工具链异常，移到纯英文短路径

## 免责声明

本项目是个人求职练习工具，与智联招聘、北森、前程无忧及任何用人单位无任何关联。流程与评分规则基于公开资料近似复刻，分数不代表任何真实考试结果。仅供面试练习使用，不得用于代替或干扰真实招聘考试。

## 许可证

[Apache-2.0](LICENSE)
