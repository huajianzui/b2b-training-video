# B 端培训视频

给 Agent 用的技能。说出模块名后，Agent 会读当前工作区的代码、把系统跑起来、列出功能供勾选，再写出演示脚本，产出：

- 带配音、字幕、片头片尾的 mp4
- 带步骤截图的 Word 操作手册
- 与成品视频同名、对齐片头时间轴的 SRT 字幕
- 按原批准范围记录覆盖情况、问题与优化建议

适用于 Cursor、Claude Code、Codex 等能加载本地 Skill 的 Agent。`scripts/script.yaml` 配有本地虚构订单页面，安装依赖后可用 `node play.js script.yaml --dry` 演练工具；页面没有后端，不保存业务数据，导出仅显示示例提示。真实系统配置写法见 [登录与查询示例](scripts/examples/authenticated.yaml)，必须替换地址、选择器和只读接口，凭据通过环境变量提供。

## 安装

把这个链接发给 Agent，让 Agent 按 [INSTALL.md](INSTALL.md) 帮你安装（右侧可复制）：

```
https://github.com/huajianzui/b2b-training-video
```

也可以自己把仓库克隆到当前 Agent 的个人技能目录（`SKILL.md` 必须直接落在该目录里）：

| 环境 | 目录 |
|---|---|
| Cursor | `~/.cursor/skills/b2b-training-video` |
| Claude Code | `~/.claude/skills/b2b-training-video` |
| Codex | `~/.codex/skills/b2b-training-video` |
| 通用 | `~/.agents/skills/b2b-training-video` |

Windows 把 `~` 换成 `$env:USERPROFILE`。把 `<目录>` 换成上表中与当前 Agent 对应的路径：

```
git clone https://github.com/huajianzui/b2b-training-video.git <目录>
```

已装过要更新时，在对应目录执行 `git pull`。

装好后，打开要做视频的项目，对 Agent 说：「给 XX 模块做培训视频」。

## 环境

- Node 20 或更高
- Python 3，以及 `edge-tts`（做视频时由 Agent 安装工具包时装上）
- 能访问微软语音服务（配音用 edge-tts 免费接口）
- 只在本地开发或独立测试环境使用。先集中确认范围与数据，按全部或小模块批量设置两轮方式，再调整例外。每次真实写入仍在确认页批准，点击后自动继续；固定禁止提交的功能不受普通批量覆盖影响。

## 升级与验证

写功能清单新增 `rehearsalMode` 和提交接口 `writeRequests`；脚本中用 `readOnlyRequests` 明确登录 POST、POST 查询等只读接口。旧写脚本需要补齐信息并请用户重新确认；旧产物从 `node produce.js <脚本.yaml>` 重新生成。详情见 [SKILL.md](SKILL.md)。

正式手册使用正式录制素材，演练手册独立命名为 `<标题>（演练）.docx`。续跑始终重新校验 YAML 与产物来源。输出共用同一把锁；不要同时运行多个脚本。

多角色使用独立工具目录和登录态，依赖可通过 PW_WORKSPACE 复用。开始前 `node preflight.js` 检查浏览器、字体和媒体；`--online` 另发送固定测试句。微软端点出现 403 时可显式设 `EDGE_TTS_SERVICE=msedge` 验证兼容端点，不修改全局 Python 包。

文案/读音更正用 `node produce.js <脚本> --post`：复用经校验的原始录像，不重放业务操作；新音频超出原画面时间窗时拒绝。阶段耗时在 output/timing.jsonl，真实提交等待在运行报告中单列。

重新盘点时，同 ID 的业务说明、权限、前提或页面信息变化也会撤销旧确认，保留用户选择并提示重新确认。人工登录完成后，在本地确认页点击“我已登录完成 · 继续”；登录确认之后，真实提交仍需本轮数据确认。

项目内工具包使用 `node <Skill目录>/scripts/install-runtime.js <项目>/.training-video` 安装或更新，包含 `tools/`、本地示例页面及登录格式示例，保留已有演示脚本和产物。`produce.js`、`play.js`、`manual.js`、`features.js`、`login.js` 的 `--help / -h` 只显示帮助，未知选项、缺参数和冲突参数在执行前报错。登录单项使用 `node login.js <脚本.yaml>`；显式 `--project <旧.json>` 保留兼容并提示迁移。背景音乐纳入合成来源校验，音乐增删或内容变化应从 compose 重跑；旧合成来源记录也需重跑 compose。

录制文件必须覆盖全部场景、旁白及留白；过短视频会明确失败，不会将时间截成零后报告完成。交付前校验必要的音视频轨道并实际解码。片头片尾生成、验收或依赖失败都会中止；从 `cards` 续跑也执行成品验收。`output/subs.srt` 保留正片时间轴，交付使用 `output/<标题>.srt`，重跑不会累计片头偏移。

覆盖升级即使保留旧 `app/index.html` 和 `build.js`，首页也只进入当前确认页，旧生成 API 返回迁移提示。提交确认会显示实际执行的脚本、环境和功能；当前打开的清单与该脚本不同会明确提示。

在仓库的 `scripts/` 中安装依赖后运行 `npm test`。该命令要求零失败、零跳过、零 TODO；缺少环境导致测试跳过时返回非零并列出准备要求。真实浏览器测试设置 `TEST_BROWSER_PATH` 指向 Chrome / Chromium；完整流水线测试还需设置 `PYTHON` 指向已安装 `requirements.txt` 的 Python 3，并安装 Playwright FFmpeg（`npx playwright install ffmpeg`）。使用自定义 Playwright 缓存时设置对应的 `PLAYWRIGHT_BROWSERS_PATH`。本机只做部分检查时显式运行 `npm run test:quick`，输出会标明未完成集成验收；TODO 在两种模式都不能作为回归通过。

[GitHub Actions](.github/workflows/regression.yml) 在 PR、main 推送及手动运行时配置 Windows、Node 24、Python 3.12、Chromium/FFmpeg 与中文字体，调用同一个 `npm test`；测试仅使用隔离目录和本机测试服务，不连接业务系统或在线 TTS。云端实际结果以 Actions 运行记录为准。

历史验证范围见 [P1 修复记录](docs/plans/p1-hardening.md) 和 [P2 修复记录](docs/plans/p2-hardening.md)。历史问题与验收边界见 [P1 复审](docs/reviews/p1-review.md) 和 [P2 复审](docs/reviews/p2-review.md)。

前轮续审与修复见 [续审计划](docs/plans/follow-up-hardening.md) 和 [续审报告](docs/reviews/follow-up-review.md)。

此前输入、标题渲染与阶段来源修复见 [输入与渲染计划](docs/plans/input-render-hardening.md) 和 [输入与渲染复审](docs/reviews/input-render-review.md)。阶段来源已绑定相关工具源码，首次升级后从 check 或完整流程重新生成；显式等待在演练中同样执行，非法 id、数值及配色表达式会报错。

安装后入口、CLI、样例与零跳过验收的修复见 [入口修复计划](docs/plans/runtime-entry-hardening.md)，最新验证与未覆盖边界见 [入口复审报告](docs/reviews/runtime-entry-review.md)。升级保留已有 YAML；旧 `examples/script.yaml` 使用本地示例时，把相对 URL 改成 `../demo/demo.html`，不要覆盖用户脚本来更新示例。

OVM 六项体验改版见 [改版计划](docs/plans/experience-revision.md) 和 [本轮验证记录](docs/reviews/experience-revision-review.md)，实施状态与未覆盖范围以该记录为准。
