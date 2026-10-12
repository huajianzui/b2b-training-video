# B 端培训视频

给 Agent 用的技能。说出模块名后，Agent 会读当前工作区的代码、把系统跑起来、列出功能供勾选，再写出演示脚本，产出：

- 带配音、字幕、片头片尾的 mp4
- 带步骤截图的 Word 操作手册

适用于 Cursor、Claude Code、Codex 等能加载本地 Skill 的 Agent。`scripts/script.yaml` 是虚构的订单管理格式示例，只看写法。

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
- 只在本地开发或独立测试环境使用。用户先批准环境，再逐功能分别选择演练和正式录制的取消或提交。每个真实提交阶段都需在本地确认页确认本轮数据已准备；演练也可以真实保存。

## 升级与验证

写功能清单新增 `rehearsalMode` 和提交接口 `writeRequests`；脚本中用 `readOnlyRequests` 明确登录 POST、POST 查询等只读接口。旧写脚本需要补齐信息并请用户重新确认；旧产物从 `node produce.js <脚本.yaml>` 重新生成。详情见 [SKILL.md](SKILL.md)。

正式手册使用正式录制素材，演练手册独立命名为 `<标题>（演练）.docx`。续跑始终重新校验 YAML 与产物来源。输出共用同一把锁；不要同时运行多个脚本。

覆盖升级即使保留旧 `app/index.html` 和 `build.js`，首页也只进入当前确认页，旧生成 API 返回迁移提示。提交确认会显示实际执行的脚本、环境和功能；当前打开的清单与该脚本不同会明确提示。

在 `scripts/` 中安装依赖后运行 `npm test`。真实浏览器测试设置 `TEST_BROWSER_PATH` 指向 Chrome / Chromium；完整流水线测试还需设置 `PYTHON` 指向已安装 `requirements.txt` 的 Python 3，并安装 Playwright FFmpeg（`npx playwright install ffmpeg`）。缺少这些配置时，测试明确显示跳过；跳过不能当作集成验收通过。

验证范围见 [P1 修复记录](docs/plans/p1-hardening.md)，剩余问题与验收边界见 [修后复审](docs/reviews/p1-review.md)。
