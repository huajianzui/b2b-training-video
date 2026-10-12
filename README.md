# B 端培训视频

给 Cursor Agent 用的 Skill。告诉它模块名，它会读**当前工作区**的代码、把系统跑起来、列出功能让你勾选，然后写出演示脚本，产出：

- 带配音、字幕、片头片尾的 mp4
- 带步骤截图的 Word 操作手册

不需要作者的业务项目。`scripts/script.yaml` 是虚构的订单管理格式示例，只看写法。

## 发给同事

仓库是私有的。先在 GitHub 把同事加成 Collaborator，再把下面整段发给他们，让他们转给自己的 Cursor Agent：

```
请按这个仓库的 INSTALL.md 把「B 端培训视频」技能安装到我的 Cursor：
https://github.com/huajianzui/b2b-training-video
装好后告诉我怎么用，不要现在做视频。
```

Agent 安装说明见 [INSTALL.md](INSTALL.md)。

## 自己安装

把本仓库放到 Cursor 的个人 Skill 目录：

```powershell
git clone https://github.com/huajianzui/b2b-training-video.git "$env:USERPROFILE\.cursor\skills\b2b-training-video"
```

```bash
git clone https://github.com/huajianzui/b2b-training-video.git ~/.cursor/skills/b2b-training-video
```

然后打开要做视频的项目，说：「给 XX 模块做培训视频」。Agent 会按 `SKILL.md` 执行。

已装过要更新：

```powershell
git -C "$env:USERPROFILE\.cursor\skills\b2b-training-video" pull
```

## 环境

- Node 20 或更高
- Python 3，以及 `edge-tts`（Agent 安装工具包时会装）
- 能访问微软语音服务（配音用 edge-tts 免费接口）
- 只在本地开发或独立测试环境使用。用户确认可以写测试数据后，写数据功能会真实保存。
