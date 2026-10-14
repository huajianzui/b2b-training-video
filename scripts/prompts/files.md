# 附件、导入与临时文件

先在准备单确认附件/普通导入/初始化导入各自范围。下载系统真实模板，另存最小样本；必填列、格式、大小、数量按真实页面和代码核实，不能伪造扩展名或上传完整业务数据。初始化导入若有现成格式文档，也应对照。Agent 自行制作文件，不把模板填写工作转给用户。

```powershell
node tools/files.js add record <已经准备好的样本.xlsx>
# 返回 output/temp-files/record/样本.xlsx 的绝对路径；在 YAML 中用相对脚本目录的路径
```

文件需在脚本目录内；执行前绑定内容摘要，确认和实际上传时再次检查。换文件后需重新运行确认；不能通过目录链接使用界外文件。

只有选择文件本身完全在浏览器内、直到最终保存才上传时，普通 `upload` 不标 `prepare`。若选择或预检提前上传、写草稿或审计，在功能清单声明实际副作用与精确接口，演练/正式许可分别经用户批准：

```yaml
# 放在对应 write 功能中，与 writeRequests（最终提交）并列
preparation:
  description: 上传导入样本并写入预检记录
  rehearsal: true
  record: true
  requests:
    - {method: POST, url: /api/import-preview}
```

```yaml
# 放在对应场景的基础 actions；定位 input[type=file]，隐藏输入框也可用
- upload:
    target: {css: 'input[type=file]'}
    files: ['output/temp-files/record/样本.xlsx']
  prepare: true
  label: 导入文件
- waitFor: {text: 预检完成}
  prepare: true
```

上传后若还要点“预检”，也用普通 click 并标 `prepare: true`；直到预检结果出现的等待动作保留此标记，以覆盖异步请求。仅放行该功能已批准的准备接口，不开放最终提交接口。写接口不能列为 `readOnlyRequests`。最终 `ending.cancel` 不代表上传从未发生，每次准备写入同样停到确认页等待用户点击。

最终保存仍放 `ending.submit`，取消放 `ending.cancel`；准备接口不能与最终提交接口重合。若系统共用同一接口且无法区分阶段，先记为待核实阻塞，不能扩大许可或假称只读。以界面真实结果断言上传/预检/导入成功，不能只验证文件框有名称。

不再需要重录或重试时执行 `node tools/files.js cleanup record`。只删除清单中内容未变的副本；任一文件变更就整批停止清理，未登记文件保留。原模板、来源文件、服务器附件与审计保留，服务端清理另按数据方案授权。纯后期可使用原录制绑定的摘要，无需恢复已清理附件；重录则须重新准备文件和确认。
