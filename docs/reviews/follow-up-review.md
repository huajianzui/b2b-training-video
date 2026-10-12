# 续审修后报告

结论：本轮继续检查上次四项 P2 以外的安装、命令入口与合成路径，复现并修复五项问题。原有演练/正式录制分开批准和本轮数据确认保持适用。修后检查相关实现、调用链、失败路径和指引，本轮五项均关闭，未发现这些改动内仍需处理的 P1/P2。

基线：101b991，实现提交：7a31130。本地修复，无推送、PR、全局 Skill 安装或真实业务操作。上次报告的“本次范围”指当时四项 P2，历史验证结果见 [P2 报告](p2-review.md)。

后续的输入、渲染与源码来源复审见 [输入与渲染报告](input-render-review.md)，包含更新的回归数量及升级提示；本页保留前轮五项问题的历史证据。

## 新发现与关闭证据

| 优先级与问题 | 复现证据 | 修复与回归 |
|---|---|---|
| P1：整目录升级覆盖用户的 script.yaml | 在隔离目录按旧指引执行 Copy-Item -Recurse -Force，目标的 USER_SCRIPT 被样例 SAMPLE 覆盖 | 新增 [install-runtime.js](../../scripts/install-runtime.js)，只更新工具代码；已有 YAML、output、依赖及字体保留，示例只在缺失时初始化。目标必须是空目录或本工具目录；执行锁、嵌套源目标、子目录链接及悬空链接在写入前拒绝。[install.test.js](../../scripts/tests/install.test.js) 验证三组正常与异常条件 |
| P2：帮助和非法 CLI 参数可能进入出片流程 | 原 --help 实际进入演练；无依赖隔离目录的帮助和参数检查回归失败，旧实现先尝试编译 YAML | [produce.js](../../scripts/produce.js) 在加载脚本和依赖前处理 --help/-h，并拒绝未知选项、缺参数及多份脚本。[cli.test.js](../../scripts/tests/cli.test.js) 验证帮助返回成功且不创建 output，非法参数返回失败且无产物 |
| P2：音乐变化没有使 compose 缓存失效 | 新增音乐后直接从 cards 续跑，原实现返回成功；新增回归先失败 | compose 来源新增音乐实际路径和 SHA-256。新增、移除或同文件内容变化须从 compose 重跑，匹配音乐可继续。[resume.test.js](../../scripts/tests/resume.test.js) 验证各条件，不把来源记录的字节夹具当作可播放音频 |
| P2：无旁白的合法场景无法合成 | 真实 FFmpeg 转码 1.4 秒 WebM，原实现把空 subs.srt 交给 libass，报 Unable to open subs.srt | 无旁白时仍实际转码视频、渲染完整静音轨并合流，仅不调用无内容的字幕滤镜。[compose.test.js](../../scripts/tests/compose.test.js) 检查空 SRT 及音视频完整解码 |
| P2：TTS 接受失败解码或零时长 | 两个 Python 故障用例在修复前分别返回 1.2 和 0.0，未拒绝 | 解码使用 -nostdin/-xerror，要求进程成功且时长大于零；失败在正式录制前终止。[tts_test.py](../../scripts/tests/tts_test.py) 验证部分解码失败、零时长及有效时长 |

## 验证

完整 **74 项 Node 测试通过，0 失败、0 跳过，约 144 秒**；其中 Python 入口运行 **10 项 Python 回归**。相较前一轮新增 7 项 Node 用例和 3 项 Python 用例，所有既有 P1/P2 回归继续通过。

31 个 JS/CJS 文件通过 node --check，7 个 Python 文件通过 AST 检查，git diff --check 通过。最后补充悬空目标链接保护后，3 项安装测试重新通过。完整流水线继续实际执行浏览器操作、两轮数据确认、录制、正式 Word、合成、片头片尾及媒体解码。

在 scripts 目录安装依赖，设置 TEST_BROWSER_PATH、PYTHON、PLAYWRIGHT_BROWSERS_PATH，运行：

```text
node --test --test-timeout=60000 tests/*.test.js
```

本次环境为 Node 24、Python 3.12、本机 Chrome 和本地隔离夹具。帮助、参数、安装升级不连接业务系统；无旁白测试使用真实编码与解码。TTS 故障测试只注入进程结果；完整流水线使用本地静音音频缓存，不证明微软在线配音服务或音色正确。

## 兼容与剩余边界

- 既有 CLI 的已记录选项保持可用；未知选项和缺参数现在明确拒绝，帮助不再执行任务。单项工具用法见各脚本顶部，不再声称全部工具提供帮助选项。
- 合成指纹补齐背景音乐。旧 compose 记录缺少该来源信息，升级后从 compose 重跑一次，保留已有录制和手册。使用背景音乐续跑时需保留 --bgm 选项。
- 工具包安装/更新指引已使用新安装脚本，保留用户数据的规则与执行代码一致。没有更新用户真实项目或个人 Skill 目录；实际项目中的权限、特殊挂载及依赖下载仍需在安装时验收。
- 未访问真实业务系统、验证系统专属数据复位或微软在线 TTS；[P2 报告](p2-review.md) 的非分片 MP4 和长视频限制、[P1 报告](p1-review.md) 的请求语义和重定向边界继续适用。
- 本轮复审覆盖上述入口和合成路径，不是对所有可能的业务系统、媒体输入和安装环境作普遍正确性保证。

计划与经验留在 [续审计划](../plans/follow-up-hardening.md)、SKILL 指引和测试。README 提供发现入口；新会话自动读取这些记录的行为未另行验收。
