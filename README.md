# B 端培训视频

给 Cursor Agent 用的 Skill。告诉它模块名，它会读工作区代码、把系统跑起来、列出功能让你勾选，然后写出演示脚本，产出：

- 带配音、字幕、片头片尾的 mp4
- 带步骤截图的 Word 操作手册

## 安装

把本仓库放到 Cursor 的个人 Skill 目录：

```powershell
git clone https://github.com/huajianzui/b2b-training-video.git "$env:USERPROFILE\.cursor\skills\b2b-training-video"
```

然后在对话里说：「给 XX 模块做培训视频」。Agent 会按 `SKILL.md` 执行。

## 环境

- Node 20 或更高
- Python 3，以及 `edge-tts`（Agent 安装工具包时会装）
- 能访问微软语音服务（配音用 edge-tts 免费接口）
- 只在本地开发或独立测试环境使用。用户确认可以写测试数据后，写数据功能会真实保存。

示例脚本已脱敏，人名和密码是占位，不能直接拿去跑。
