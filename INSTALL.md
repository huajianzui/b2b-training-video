# 安装「B 端培训视频」技能

这份说明给正在执行安装的 Agent。现在只做安装，**不要开始做培训视频**，**不要向用户要业务系统的代码路径或网址**。

## 技能做什么

读当前工作区里的 B 端系统代码，把系统跑起来，盘点功能让用户勾选，再写出演示脚本并出片：

- `<名字>.mp4`：配音、字幕、片头片尾
- `<名字>手册.docx`：每步带红框截图

装好后，用户打开要做视频的项目，说「给 XX 模块做培训视频」即可。演示对象是用户自己工作区里的系统。

## 1. 装到哪里

按**当前正在对话的 Agent**选择个人技能目录（对本机所有项目生效）：

| 环境 | 目录 |
|---|---|
| Cursor | `~/.cursor/skills/b2b-training-video` |
| Claude Code | `~/.claude/skills/b2b-training-video` |
| Codex | `~/.codex/skills/b2b-training-video` |
| 其他 / 无法判断 | `~/.agents/skills/b2b-training-video` |

Windows 把 `~` 换成 `$env:USERPROFILE`。从进程、工作区配置或已有技能目录判断当前环境，不要默认只装 Cursor。

装完后，`SKILL.md` 必须**直接**落在这个目录里，不能多套一层文件夹。

仓库地址：`https://github.com/huajianzui/b2b-training-video.git`

用户明确要求「只给当前项目用」时，改装到该项目的 `.cursor/skills/`、`.claude/skills/` 或 `.agents/skills/`（与当前 Agent 对应）。默认装个人目录。

## 2. 执行安装

先看目标目录在不在、是不是本仓库。把 `<目录>` 换成第 1 步选定的路径。

**还没有这个目录** — 先建父目录，再克隆：

```
git clone https://github.com/huajianzui/b2b-training-video.git <目录>
```

**目录已在，且 remote 是本仓库** — 更新：

```
git -C <目录> pull --ff-only
```

**目录已在，但不是 git 仓库或 remote 不对** — 停下来告诉用户，不要覆盖。

不要在技能目录里跑 `npm install`。工具包是做视频时由 `SKILL.md` 复制到工作区 `.training-video/` 再装的。

## 3. 克隆失败

本仓库是公开的。若 `git clone` 失败，把报错原文告诉用户，检查网络或 Git 是否可用。不要改用其他仓库，不要跳过安装去写脚本。

## 4. 验收

下面两个文件都在，才算装好：

- `<技能目录>/SKILL.md`
- `<技能目录>/scripts/produce.js`

用用户能看懂的话回复：

- 已安装（或已更新）到哪个目录
- 下次怎么用：打开要做视频的项目，对 Agent 说「给 XX 模块做培训视频」
- 需要 Node 20+、Python 3（做视频时会再装 `edge-tts`）
- 只在本地开发或独立测试环境使用

到此结束。等用户下次点名模块，再读 `SKILL.md` 执行。
