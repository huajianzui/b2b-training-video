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
- 只在本地开发或独立测试环境使用。确认可以写测试数据后，写数据功能会真实保存。
