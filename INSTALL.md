# 给 Agent：安装「B 端培训视频」技能

你正在读这份说明，是因为用户把本仓库链接发给了你，要你**安装技能**。现在只做安装，**不要开始做培训视频**，**不要向用户要任何业务系统的代码路径或网址**。

本仓库本身就是一份 Cursor 个人 Skill。装好后，用户在任意工作区说「给 XX 模块做培训视频」即可。对方用自己工作区里的代码和系统，不需要作者的项目。

## 1. 装到哪里

个人 Skill 目录（对本机所有项目生效）：

| 系统 | 目录 |
|---|---|
| Windows | `$env:USERPROFILE\.cursor\skills\b2b-training-video` |
| macOS / Linux | `~/.cursor/skills/b2b-training-video` |

装完后，`SKILL.md` 必须**直接**落在这个目录里，不能多套一层文件夹。

仓库地址：`https://github.com/huajianzui/b2b-training-video.git`

## 2. 执行安装

先看目标目录在不在、是不是本仓库。

**还没有这个目录** — 克隆：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.cursor\skills" | Out-Null
git clone https://github.com/huajianzui/b2b-training-video.git "$env:USERPROFILE\.cursor\skills\b2b-training-video"
```

```bash
mkdir -p ~/.cursor/skills
git clone https://github.com/huajianzui/b2b-training-video.git ~/.cursor/skills/b2b-training-video
```

**目录已在，且 remote 是本仓库** — 更新：

```powershell
git -C "$env:USERPROFILE\.cursor\skills\b2b-training-video" pull --ff-only
```

```bash
git -C ~/.cursor/skills/b2b-training-video pull --ff-only
```

**目录已在，但不是 git 仓库或 remote 不对** — 停下来告诉用户，不要覆盖。

装进当前项目的 `.cursor/skills/` 只在用户明确要求「只给这个项目用」时才做。默认装个人目录。

不要在 Skill 目录里跑 `npm install`。工具包是用户做视频时，由 `SKILL.md` 复制到工作区 `.training-video/` 再装的。

## 3. 克隆失败

本仓库是**私有**的。若 `git clone` 返回 404 或 Authentication failed：

1. 说明：当前 GitHub 账号没有这个仓库的权限。
2. 请用户让仓库主人在 GitHub 把 TA 加成 Collaborator，并在本机完成 `gh auth login` 或 Git Credential 登录。
3. 不要改用其他仓库，不要跳过安装去写脚本。

## 4. 验收

下面两个文件都在，才算装好：

- `<技能目录>/SKILL.md`
- `<技能目录>/scripts/produce.js`

用用户能看懂的话回复：

- 已安装（或已更新）到哪个目录
- 下次怎么用：打开**自己要做视频的那个项目**工作区，对 Agent 说「给 XX 模块做培训视频」
- 需要 Node 20+、Python 3（做视频时会再装 `edge-tts`）
- 只在本地开发或独立测试环境使用

到此结束。等用户下次点名模块，再读 `SKILL.md` 执行。
