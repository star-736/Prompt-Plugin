# FutureContext for Edge

FutureContext 是一个本地优先的 Edge / Chrome 扩展，用于保存、分类、编辑和复制：

- 通用 Prompt
- 单文件或从 GitHub 收集的包式 `SKILL.md`
- 普通与私密 AIGC Prompt
- 终端指令（各类 CLI / AI Agent 命令、快捷键速查等）

完整产品范围见 [一期规格](./SPEC.md) 与 [二期规格](./SPEC_PHASE2.md)，术语与隐私边界见 [CONTEXT.md](./CONTEXT.md)。

## 当前能力

### GitHub 收集认证

在扩展「设置 → GitHub Token（可选）」粘贴个人访问令牌并保存；再次填写可替换，点击「移除 Token」恢复匿名请求。Token 用于提高公开仓库的 GitHub API 额度，并让失败原因更清楚。保存仅验证格式，不向 GitHub 发起请求；额度、权限或过期问题会在收集/更新时提示。可从 [GitHub Token 设置](https://github.com/settings/tokens) 创建令牌。

Token 明文只存在此浏览器配置文件的扩展存储中，不写入资料库或导出备份，不在表单中回显。卸载扩展或清除扩展数据会删除它；能使用此浏览器配置文件的人可以读取它。它只发送到 `https://api.github.com`，请求不跟随重定向。

遇到额度耗尽或临时限流时，提示会在服务器提供相关响应头时显示本地时间的重试时间；网络失败、401、403 和 404 分别给出不同原因。限流不会自动重试，也不做重复请求合并。规则参考 [GitHub API 限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

### 资产管理

- 工具栏弹窗内完成四类资产的搜索、一级分类、编辑、复制与永久删除。
- 终端指令用于收集各类 CLI / AI Agent 命令、更新指令、快捷键速查等；支持可选标题与一级分类，正文以等宽字体展示，复制即为原始命令。它只保存在本地，永不发送给 AI Provider。
- Skill 可直接编辑带 YAML frontmatter 的 `SKILL.md`，也可从公开 GitHub 的具体 `SKILL.md` 页面收集同目录完整包；包内脚本仅保存、绝不执行。
- 通用 Prompt 标题可选；配置后台 AI 后可无感补全标题和归入分类。AIGC Prompt 永不发送给 AI Provider。
- 支持 OpenAI、OpenCode Go、DeepSeek、OpenRouter 和自定义 OpenAI 兼容 Provider；API Key 由私密库密码加密保存，并只在当前浏览器会话解锁后供后台使用。
- AIGC Prompt 可在普通库和私密库之间明确迁移。
- 私密库使用可恢复的本地隐私锁：关闭弹窗即重新锁定；重设密码不会删除内容。
- 编辑草稿自动保留，避免弹窗关闭导致输入丢失。
- 支持本地 JSON 完整备份；导入只合并新内容，不覆盖已有条目。
- 无账号、无云同步、无自动填入网页输入框；GitHub 收集和用户配置的 Provider 调用都必须由用户主动启用并授予对应站点权限。

## 隐私边界

私密库的目标是防止他人随手打开 FutureContext 查看 AIGC 内容。它不是不可恢复的强加密保险箱：拥有浏览器配置文件或本机账户访问权的人，仍可能重设隐私锁或访问浏览器本地数据。

完整备份文件包含私密内容。导出前请确认存放位置可靠。

## 安装到 Edge

1. 打开 `edge://extensions` 并开启“开发人员模式”。
2. 点击“加载解压缩的扩展”。
3. 选择本项目根目录 `C:\Users\STAR07\OneDrive\Desktop\prompt-plugin`。
4. 将 FutureContext 固定到 Edge 工具栏后点击图标即可使用。

Chrome 同样可通过 `chrome://extensions` 加载。

## 开发与验证

```powershell
npm test
npm run check
```

项目不依赖运行时或构建工具，使用原生 Manifest V3、`chrome.storage`、IndexedDB 与 Web Crypto。GitHub 包资源保存在 IndexedDB；API Key 使用 PBKDF2 + AES-GCM 加密后本地保存。
