# FutureContext for Edge

FutureContext 是一个本地优先的 Edge / Chrome 扩展，用于保存、分类、编辑和复制：

- 通用 Prompt
- 单文件或从 GitHub 收集的包式 `SKILL.md`
- 普通与私密 AIGC Prompt

完整产品范围见 [一期规格](./SPEC.md) 与 [二期规格](./SPEC_PHASE2.md)，术语与隐私边界见 [CONTEXT.md](./CONTEXT.md)。

## 当前能力

- 工具栏弹窗内完成三类资产的搜索、一级分类、编辑、复制与永久删除。
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
