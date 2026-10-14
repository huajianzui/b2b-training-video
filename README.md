# B 端培训视频生成 Skill (b2b-training-video)

这是一个专为 AI 编程助手（Cursor、Claude Code、Codex 等）设计的本地 Skill。

只需告诉 Agent 你要演示的**业务模块名**，Agent 就会自动阅读当前项目代码、启动服务、盘点功能清单供你勾选，并自动编写录制脚本，最终一键产出：
- 🎬 **成品培训视频（.mp4）**：带语音旁白、对齐字幕、片头与片尾
- 📄 **Word 操作手册（.docx）**：包含完整步骤说明与对应界面截图
- 💬 **外挂字幕文件（.srt）**：与成品视频同名，已自动对齐片头时间轴
- 📊 **覆盖与诊断报告**：对比勾选范围记录演示覆盖情况、异常问题与优化建议

---

## 🚀 快速安装与使用

### 方式一：让 Agent 自动安装（推荐）
直接把本仓库地址发给你的 Agent，让它按照 [INSTALL.md](INSTALL.md) 自动完成部署（拷贝下方链接发给 Agent）：

    https://github.com/huajianzui/b2b-training-video

### 方式二：手动克隆到个人技能目录
将本仓库直接克隆到对应 Agent 的个人技能目录下（确保 `SKILL.md` 直接位于该目录根部，Windows 请将 `~` 替换为 `$env:USERPROFILE`）：

| Agent 环境 | 目标安装路径 |
| :--- | :--- |
| **Cursor** | `~/.cursor/skills/b2b-training-video` |
| **Claude Code** | `~/.claude/skills/b2b-training-video` |
| **Codex** | `~/.codex/skills/b2b-training-video` |
| **通用环境** | `~/.agents/skills/b2b-training-video` |

在终端执行克隆命令（将 `<目录>` 替换为上表对应路径，后续更新只需在该目录下执行 `git pull`）：

    git clone https://github.com/huajianzui/b2b-training-video <目录>

### 开始使用
安装完成后，用 Agent 打开你的目标业务项目，直接对话即可：
> **「给 XX 模块做培训视频」**

---

## 🛡️ 环境要求与安全机制

### 基础环境
- **Node.js**：20 或更高版本
- **Python 3** 及 `edge-tts`（首次制作视频时，Agent 会自动协助安装依赖包）
- **网络**：需能正常访问微软语音合成服务（使用 `edge-tts` 免费配音接口）

### 为什么安全？（防脏数据机制）
> ⚠️ **注意**：请仅在本地开发环境或独立测试环境中使用本工具。

为了防止 AI 在自动录制过程中误操作污染业务数据，本工具内置了严格的**“先演练、后实录，写操作人工拦截”**机制：
1. **范围盘点与确认**：录制前先在本地确认页集中确认范围与数据，支持按全部或小模块批量设置两轮方式并调整例外（固定禁止提交的功能不受普通批量覆盖影响）。若同 ID 的业务说明、权限、前提或页面信息变化，会自动撤销旧确认并提示重新确认。
2. **两轮录制模式（演练 vs 正式）**：
   - 默认支持先跑一轮 **演练模式（Rehearsal / Dry Run）**，仅验证页面跳转与只读查询（通过 `readOnlyRequests` 明确放行登录 POST、查询 POST 等只读接口），不触发真实写入，并生成独立的 `<标题>（演练）.docx` 手册。
   - **正式录制**中，任何涉及真实写入（`writeRequests`）或附件/导入上传（`upload` 动作，上传预检与最终提交分别批准）的操作，都会在执行前暂停，**必须由你在本地确认页手动点击批准后才会继续提交**。
3. **测试文件隔离**：上传附件或导入数据时，样本按内容摘要绑定，`tools/files.js add/cleanup` 仅管理本轮登记的临时副本，绝不破坏原始样本文件。

---

## 🛠️ 常用命令与调试速查

除了让 Agent 全自动执行，你也可以使用内置命令进行单项调试或后期微调（详细规范见 [SKILL.md](SKILL.md) 与 [文件参考](scripts/prompts/files.md)）：

| 使用场景 | 执行命令 / 配置 | 说明 |
| :--- | :--- | :--- |
| **零后端体验 Demo** | `node play.js script.yaml --dry` | 在 `scripts/` 下运行，使用内置本地虚构订单页体验演练流程（真实系统写法见 [登录与查询示例](scripts/examples/authenticated.yaml)） |
| **环境与语音自检** | `node preflight.js --online` | 检查浏览器、字体和媒体；`--online` 另发送固定测试句验证微软 TTS 接口 |
| **微软配音报 403** | 设置 `EDGE_TTS_SERVICE=msedge` | 显式验证兼容端点，不修改全局 Python 包 |
| **只改文案/配音（免重录）** | `node produce.js <脚本.yaml> --post` | 复用经校验的原始录像，不重放业务操作（新音频超出原画面时间窗时拒绝） |
| **更换背景音乐** | 从 `compose` 阶段重跑 | 背景音乐纳入合成来源校验，音乐增删或内容变化从 `compose` 重跑即可 |
| **单独调试登录流程** | `node login.js <脚本.yaml>` | 仅验证登录单项；人工登录完成后在本地确认页点击“我已登录完成 · 继续” |
| **仅验证演练阶段** | `script.js` / `login.js` 加 `--rehearsal` | `produce --dry` 会自动选择演练阶段 |
| **安装/更新项目工具包** | `node <Skill目录>/scripts/install-runtime.js <项目>/.training-video` | 在项目内安装或更新工具包（含 `tools/`、本地示例及登录示例），保留已有脚本和产物 |

*补充说明：多个脚本共用同一把输出锁，请勿同时运行多个脚本；多角色演示请使用独立工具目录和登录态，依赖可通过 `PW_WORKSPACE` 复用。阶段耗时记录在 `output/timing.jsonl`，真实提交等待在运行报告中单列。*

---

## 🧪 开发者测试与历史归档

如果你需要修改本 Skill 的源码并进行回归验证：

1. **运行完整测试**：在仓库的 `scripts/` 中安装依赖后运行 `npm test`。
   - **严格验收标准**：要求零失败、零跳过、零 TODO；缺少环境导致测试跳过时返回非零并列出准备要求。
   - **环境配置**：真实浏览器测试需设置 `TEST_BROWSER_PATH` 指向 Chrome/Chromium；完整流水线测试还需设置 `PYTHON` 指向已安装 `requirements.txt` 的 Python 3，并安装 `npx playwright install ffmpeg`（自定义缓存可设 `PLAYWRIGHT_BROWSERS_PATH`）。
2. **本机快速检查**：若只做部分检查可显式运行 `npm run test:quick`（输出会标明未完成集成验收）。
3. **CI 自动化验证**：GitHub Actions 在 PR、`main` 推送及手动运行时会自动配置 Windows、Node 24、Python 3.12、Chromium/FFmpeg 与中文字体并执行 `npm test`（仅使用隔离目录和本机测试服务）。

### 架构演进与复审归档
历史验证范围见 [P1 修复记录](docs/plans/p1-hardening.md) 和 [P2 修复记录](docs/plans/p2-hardening.md)。历史问题与验收边界见 [P1 复审](docs/reviews/p1-review.md) 和 [P2 复审](docs/reviews/p2-review.md)。

前轮续审与修复见 [续审计划](docs/plans/follow-up-hardening.md) 和 [续审报告](docs/reviews/follow-up-review.md)。

此前输入、标题渲染与阶段来源修复见 [输入与渲染计划](docs/plans/input-render-hardening.md) 和 [输入与渲染复审](docs/reviews/input-render-review.md)。

安装后入口、CLI、样例与零跳过验收的修复见 [入口修复计划](docs/plans/runtime-entry-hardening.md)，最新验证与未覆盖边界见 [入口复审报告](docs/reviews/runtime-entry-review.md)。
