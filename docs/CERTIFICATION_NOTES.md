# Microsoft Edge Add-ons 审核备注

将以下内容粘贴到 Partner Center 的 **Notes for certification**。内容按当前 `0.1.0` 实现编写。

## English (recommended)

FutureContext is a local-first toolbar-popup extension for saving, organizing, editing, searching, and explicitly copying reusable AI content. It supports generic prompts, complete single-file SKILL.md content, regular AIGC prompts, and a separate private AIGC library.

How to test:
1. Click the FutureContext toolbar icon to open the popup.
2. In Generic Prompt or Skill, use New to create an item; enter content and save. For Skill, paste a complete SKILL.md with YAML frontmatter containing `name` and `description`.
3. Use Copy on an item. The extension copies text only and never injects text into webpages.
4. Open AIGC Prompt and select the private library. On first access, set a password of at least six characters. Locking/closing the popup hides all private item titles and counts until the password is entered again.
5. In Settings, export/import a local JSON backup. Export requires the private library to be unlocked; backup data is written only to the user-selected local file.

Privacy and permissions:
- The only requested permission is `storage`, used to save user-created content and extension state in `chrome.storage.local`.
- The extension has no host permissions, content scripts, accounts, analytics, network requests, remote code, cloud sync, webpage reading, automatic form filling, or AI model calls.
- User content remains in the current browser profile unless the user explicitly exports a local JSON backup.
- The private library is a recoverable local privacy lock, not an unrecoverable strong-encryption claim. Resetting the lock preserves the content.

## 中文备用版

FutureContext 是本地优先的工具栏弹窗扩展，用于保存、分类、编辑、搜索和手动复制通用 Prompt、完整单文件 SKILL.md、普通 AIGC Prompt 与私密 AIGC Prompt。

测试方式：点击工具栏图标打开弹窗；在“通用 Prompt”或“Skill”中新建并保存条目；Skill 请粘贴包含 `name` 与 `description` YAML frontmatter 的完整 SKILL.md；点击复制只会复制文字，不会向网页自动填入内容。进入“AIGC Prompt”的私密库，首次设置至少六位密码，关闭弹窗或锁定后不会显示私密条目标题和数量。设置页支持本地 JSON 导入导出；导出时要求私密库已解锁，备份只写入用户选择的本地文件。

唯一权限为 `storage`，仅用于 `chrome.storage.local` 中保存用户创建的内容和扩展状态。扩展没有 host permissions、content scripts、账号、分析、网络请求、远程代码、云同步、网页读取、自动填表或模型调用。除非用户主动导出 JSON，本地内容不会离开当前浏览器配置文件。私密库是可恢复的本地隐私锁，并非不可恢复的强加密承诺；重设访问锁不会删除内容。
