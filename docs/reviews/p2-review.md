# P2 修后复审

结论：P1 报告中的四项 P2 已修复并补充回归。主代理重新检查改动、相关调用链和失败路径，在本次范围内未发现剩余可触发的 P1/P2。复审同时保留 P1 的环境批准、演练与正式录制分别确认、本轮数据确认、请求保护和续跑来源约束。

范围：从 `8ce85e1` 开始的本地修复。实现提交为 `2a1202d`、`866f481`；未推送、未创建 PR、未安装全局 Skill、未操作真实业务系统。

## 四项关闭结果

| 问题 | 修复前证据 | 修后行为与回归 |
|---|---|---|
| 同 ID 的业务信息变化不撤销确认 | 新增合并回归在原版全部失败；permission、when、requires 等变化仍保留 confirmedAt | [features.js](../../scripts/features.js) 比较标准化的业务字段及页面/模块信息；变化撤销确认并标 changed。保留用户环境、勾选及两轮收尾，重复盘点不清掉待确认的变化标记；单纯盘点时间和 Agent 名称变化不撤销确认。[features.test.js](../../scripts/tests/features.test.js) 覆盖十类功能字段、四类页面字段、模块名及重复合并；真实桌面 UI 验证变化提示和重新确认 |
| 最终媒体故障可能显示完成 | 原版空文件、缺 moov、缺轨道、损坏负载等五项媒体回归失败；缺 Node、校验超时、忽略 False、ffmpeg 留下部分文件四项 Python 故障回归失败；片头失败和 cards 续跑空文件仍能完成 | [mp4info.js](../../scripts/tools/mp4info.js) 验证容器和必要轨道，流水线实际完整解码；[intro.py](../../scripts/intro.py) 传播校验及进程失败；[produce.js](../../scripts/produce.js) 在所有交付路径验收，片头失败即中止。[media.test.js](../../scripts/tests/media.test.js)、[intro_test.py](../../scripts/tests/intro_test.py)、[delivery.test.js](../../scripts/tests/delivery.test.js) 覆盖正常与故障路径 |
| 带片头的成品 SRT 沿用正片时间轴 | 实际生成片头后，首个正文可识别帧约在 1.04 秒，原 SRT 第一条仍是 0 秒；原版交付回归失败 | 保留正片 subs.srt；交付同名 `<标题>.srt`，使用实际拼接模式和轨道时长平移。重编码时归零各段时间戳，并按视频时长裁切/补齐音频，避免 AAC 尾部影响起点。真实解码帧的 PTS 与首条字幕起点误差小于两个 25fps 帧；验证片头、片尾、两者同时存在、淡入、流复制、无卡片、重复续跑和改变片头时长。禁止成品名字覆盖内部正片字幕；[subtitles_test.py](../../scripts/tests/subtitles_test.py) 验证中文、多行、跨小时、CRLF、零偏移及非法时间 |
| 非 TTY 网页任务缺少人工登录完成入口 | start:manual 的真实登录后，原确认页没有登录按钮，新增 UI 回归失败 | [features.html](../../scripts/app/features.html) 显示登录等待、页面和继续按钮；发送当前 runId，重复及失效确认明确拒绝。登录识别失败时显示既有的明确继续选择；登录确认不能替代业务提交确认。[execution.test.js](../../scripts/tests/execution.test.js) 实际验证登录 POST、人工继续、独立数据确认，批准数据前后台业务写入计数保持零 |

## 验证结果

全量 **67 项 Node 测试通过，0 失败、0 跳过，约 132 秒**。Python 测试入口实际执行 **7 项 Python 回归**，全部通过。

| 测试文件 | Node 用例数 | 主要内容 |
|---|---:|---|
| execution.test.js | 12 | P1 写入约束、人工登录 UI、实际录制、正式 Word、合成与片头片尾 |
| features.test.js | 3 | 同 ID 信息变化、页面与模块变化、保留决策、重复合并 |
| media.test.js | 5 | 空/截断/缺轨道、损坏视频负载、缺解码器、有效媒体 |
| delivery.test.js | 7 | 生成失败与续跑空媒体中止，实际字幕时间轴及重复生成 |
| python.test.js | 1 | 调用 7 项 Python 故障与字幕边界回归 |
| permissions.test.js | 9 | 环境、两轮收尾、脚本及迁移约束 |
| requests.test.js | 9 | 未批准请求、HEAD、重定向、响应未知、WebSocket |
| resume.test.js | 14 | 当前 YAML、身份、产物哈希、输出锁和有效续跑 |
| server.test.js | 7 | 本机服务来源、令牌、文件边界与旧入口 |

27 个 JS/CJS 文件通过 `node --check`，6 个 Python 文件通过 AST 检查，`git diff --check` 通过。统一登录提示的按钮名称后，人工登录 UI 回归再次通过。实际渲染与截图检查范围为桌面 1440×900；登录等待、按钮、写入确认提示均可见，任务等待期间功能编辑保持禁用。

复现：在 scripts 安装依赖，设置 TEST_BROWSER_PATH 指向 Chrome/Chromium，PYTHON 指向已安装 requirements.txt 的 Python，并安装 Playwright FFmpeg。自定义浏览器缓存时同样设置 PLAYWRIGHT_BROWSERS_PATH。

```text
node --test --test-timeout=60000 tests/*.test.js
```

本次使用 Node 24、Python 3.12、真实本机 Chrome 和隔离的本机业务夹具。完整流水线用本地产生的静音 MP3 缓存，实际执行 tts.py 缓存读取、演练、录制、手册、合成、片头片尾与解码验收；卡片明确配置为空旁白。不把这些结果当作微软在线音色或配音内容验收。故障单元测试中的模拟仅用于注入缺依赖、超时和部分文件，实际拼接与字幕验收使用真实 FFmpeg。

## 修后复审与边界

- 合并比较覆盖实际标准化字段，用户选择和盘点时间独立处理；旧确认撤销后不能出片。两轮提交方式保持用户既有选择。
- 验收失败、缺依赖、超时和卡片生成失败均返回失败；cards 续跑与无卡片交付没有绕过最终解码。单独使用 intro.py --no-verify 明确输出“待校验”，流水线不使用该选项。
- 成品字幕独立于正片字幕；重复生成不会再次平移输入，也不会使 compose 缓存指向成品字幕。修复 Windows 换行转换，零偏移保持原字幕内容。
- 登录按钮仅发送登录确认，仍受本机来源与令牌保护；没有写入许可。后续数据批准重新检查当前脚本、身份与输入。
- 未验证真实系统的权限、验证码/单点登录、数据复位及在线 TTS。客户端不能推断未知 GET 写语义；共享 GraphQL/RPC、WebSocket 写通道、Service Worker 和导航重定向边界继续适用 [P1 报告](p1-review.md) 的说明。
- 媒体解析面向工具生成的非分片 MP4，不宣称支持任意外部媒体。intro.py 校验仍使用原有 60 秒超时，超时会失败；长视频和真实在线音轨需要按目标系统及运行机器验收。

修复经验已写入 [P2 计划](../plans/p2-hardening.md)、[SKILL.md](../../SKILL.md)、盘点提示和回归测试。README 已链接当前计划与复审，后续修改从这些入口复用证据；已检查文件链接存在，新会话中 Agent 是否实际读取和复用尚未另行验收。
