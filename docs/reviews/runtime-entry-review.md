# 安装与单项入口复审

日期：2026-10-13。基线：main `f553cfa`。实现提交：`2a51e4cf20d50f589d9060b168a3b47ca397804c`，本地分支 `fix/runtime-entries`。

用户列出的两项 P1 和三项 P2 已修复并补充回归。P3 已增加完整验收入口与 GitHub Actions 配置；云端实际运行仍待推送后验收。没有推送、创建 PR、删除远端分支或操作真实业务系统。

## 修复与证据

| 问题 | 当前行为与回归 |
|---|---|
| 安装遗漏 tools | 安装清单包含快照与 MP4 诊断工具、本地页面；从全新安装目录真实运行示例、快照和实际解码。新增 tools/demo 目标链接在任何写入之前拒绝。 |
| play 帮助、未知参数执行任务 | play/manual/features/login 使用严格参数解析，在依赖、配置、锁和执行之前处理帮助及错误。已有有效 YAML、缓存来源和 TTS 清单时，帮助及拼错的演练参数仍零导航、零业务写入、不录制、不改产物。非法参数也不能确认清单或删除登录态。 |
| 登录接口与文档不一致 | 默认与位置参数读取 YAML，经同一个归一化接口进入登录模块；显式 --project 保留旧 JSON 兼容并给出迁移提示。损坏的旧 project.json 不影响 YAML 调用。 |
| 登录、只读接口、读音样例缺失 | examples/authenticated.yaml 给出完整字段、环境变量凭据占位和精准 POST 只读规则；明确要求替换 URL、选择器并核对接口语义。真实 loadScript 校验其登录配置和配音替换，字幕仍保留原词。 |
| 示例页面不存在 | 本地虚构订单页面实际随包安装；根目录与 examples 下的示例各自解析正确路径，均通过五场景演练。每个场景独立导航，单独演练第二个场景也通过。页面没有后端，导出仅提示。 |
| 跳过测试也成功退出 | npm test 要求零失败、零跳过、零 TODO；失败、中止、缺少测试或汇总不能报成功。test:quick 仅显式允许跳过，并标明集成验收未完成。真实子进程回归覆盖全通过、跳过、失败、TODO 和无测试目录。 |
| 缺少 CI | .github/workflows/regression.yml 配置 Windows、Node 24、Python 3.12、Chromium/FFmpeg 与中文字体，调用同一个 npm test。媒体夹具包含准备好的字体；工作流 YAML 和 PowerShell 均通过本地语法检查。 |

首次完整回归另发现：实际视频只有一秒时，时间对齐将负值截成零，仍报告录制成功。用真实一秒 WebM 稳定复现后增加场景、旁白与留白覆盖检查；过短文件现在明确失败，不写入成功 session、不继续交付。原正常录制时长断言保留并通过。首次浏览器为何生成过短文件未确定；本次修复的是执行器对该故障的假成功处理，不保证浏览器永不缺帧，也不自动重试已提交的操作。

收尾复审还复现了 Node 对 TODO 断言失败返回成功退出码的情况；验收入口现在读取 TODO 汇总，完整和部分模式都拒绝将其报告为回归通过。

## 验收结果

修改前的定向回归为 5 通过、13 失败、0 跳过，覆盖旧入口与安装缺口。首次完整验收为 103 通过、1 失败、0 跳过，确实暴露了上述录制异常；没有修改或放宽原时长断言。

最终代码在本机用户上下文执行真实 npm test，使用 Node 24.19.0、Python 3.12.14、Chrome、Playwright FFmpeg 和已安装的 Python 依赖：

```text
# tests 106
# pass 106
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 172355.4339
[完整验收通过] 106 项通过，0 失败、0 跳过。
进程退出码：0
```

106 个 Node 测试包含执行 12 个 Python 回归的汇总用例，不能将两个计数简单相加。本轮新增 22 个 Node 回归，保留原有 84 个用例。

清除 PYTHON、TEST_BROWSER_PATH 和 PLAYWRIGHT_BROWSERS_PATH 后，真实 npm test 为 68 通过、38 跳过、0 失败，退出码 **2**，明确打印“完整验收未通过”及环境准备要求。部分模式成功与失败边界由真实子进程回归验证。

36 个 JS/CJS 文件语法检查、7 个 Python 文件 AST 检查、工作流 YAML/PowerShell 语法及 Git 空白检查通过。1920×1080 的安装后页面截图已渲染并检查。测试仅使用临时目录、本机服务和本地静音配音素材；真实演练、两轮确认、登录、请求拦截、录屏、Word、字幕和 FFmpeg 实际解码均执行。

## 升级和未覆盖边界

- 升级继续保留用户 YAML、清单、产物、依赖与字体。旧 examples/script.yaml 不自动覆盖；引用本地示例时需将 URL 改成 ../demo/demo.html。
- 共享 CLI 纳入浏览器及手册实现指纹；旧阶段产物首次升级后应从 check 或完整流程重跑。有效的 YAML 缓存来源回退及显式旧 JSON 登录调用保留。
- 环境写入批准、演练和正式录制各自的取消/提交选择及每轮数据确认沿用既有方案；没有把演练改成强制取消。
- Actions 云端尚未执行；本地静态检查和本机全量通过不能替代云端首次运行。CI 使用的配置依据见 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[setup-python](https://github.com/actions/setup-python) 和 [Noto CJK 字体目录](https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese)。
- 未验收真实业务系统的接口语义、所有登录方式、在线 TTS 服务或非 Windows 环境；这些需要在目标环境依实际业务规则验收。
- 已合并的远端 fix/p1-hardening 分支保留；外部删除未在本轮执行。

复发预防已经落入 README、SKILL、[入口修复计划](../plans/runtime-entry-hardening.md) 及安装/CLI/运行入口回归：验证从新安装目录出发，并分别覆盖无配置、损坏配置和有效旧产物；“没有失败”必须同时检查跳过与待完成项。复审沿用先前确认的提交边界及来源校验规则，没有发现本轮范围内仍未修复的 P1/P2 问题。
