# FutureContext for Edge

FutureContext 是一个本地优先的 Edge / Chrome 扩展，用于保存、分类、编辑和复制：

- 通用 Prompt
- 单文件 `SKILL.md`
- 普通与私密 AIGC Prompt

完整产品范围见 [SPEC.md](./SPEC.md)，术语与隐私边界见 [CONTEXT.md](./CONTEXT.md)。

## 一期能力

- 工具栏弹窗内完成三类资产的搜索、一级分类、编辑、复制与永久删除。
- Skill 只接受带 YAML frontmatter 的单个 `SKILL.md`，并校验 `name` 与 `description`。
- AIGC Prompt 可在普通库和私密库之间明确迁移。
- 私密库使用可恢复的本地隐私锁：关闭弹窗即重新锁定；重设密码不会删除内容。
- 编辑草稿自动保留，避免弹窗关闭导致输入丢失。
- 支持本地 JSON 完整备份；导入只合并新内容，不覆盖已有条目。
- 无账号、无云同步、无网页读取、无自动填入网页输入框。

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

项目不依赖运行时或构建工具，使用原生 Manifest V3、`chrome.storage.local` 与 Web Crypto 的 SHA-256 摘要校验隐私锁密码。
