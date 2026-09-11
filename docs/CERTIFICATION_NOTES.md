# Microsoft Edge Add-ons 审核备注

将以下内容粘贴到 Partner Center 的 **Notes for certification**。内容按当前 `0.2.0` 实现编写。

## English (recommended)

FutureContext is a local-first toolbar-popup extension for saving, organizing, editing, searching, and explicitly copying reusable AI content. It supports generic prompts, Skills (including explicit public GitHub SKILL.md directory collection), regular AIGC prompts, a separate private AIGC library, and terminal commands.

How to test:
1. Click the FutureContext toolbar icon to open the popup.
2. In Generic Prompt or Skill, use New to create an item; enter content and save. Generic Prompt titles are optional. For Skill, paste a complete SKILL.md with YAML frontmatter containing `name` and `description`.
3. Use Copy on an item. The extension copies text only and never injects text into webpages.
4. Open AIGC Prompt and select the private library. On first access, set a password of at least six characters. Locking/closing the popup hides all private item titles and counts until the password is entered again.
5. In Settings, configure a Provider only if you want background organization. The extension requests that Provider's API origin at this moment. Enter the private-library password to encrypt the API Key; unlock once per browser session before testing or processing. Only Generic Prompt and Skill content are sent; AIGC, terminal commands, and drafts are never sent.
6. To test GitHub collection, open a public repository's concrete SKILL.md page, open the popup's Skill tab, and click “从当前 GitHub 页面收集”. The extension requests GitHub permission, reads only that Skill directory through the GitHub API, stores it locally, and never executes scripts. In the saved Skill detail, use “检查 GitHub 更新” for a manual update.
7. In Settings, export/import a local JSON backup. Export requires the private library to be unlocked; backup data is written only to the user-selected local file.

Privacy and permissions:
- Required permissions are `storage`, `activeTab`, `scripting`, `alarms`, and `permissions`. `storage` stores extension state; `activeTab` and `scripting` are used only after the user explicitly starts GitHub Skill collection; `alarms` batches background organization; `permissions` requests a specific Provider or GitHub origin at the user's action.
- Optional host access is requested only for public GitHub collection or the Provider endpoint explicitly configured by the user. There is no automatic webpage scanning, automatic form filling, remote code execution, account, analytics, cloud sync, or developer-operated server.
- User content remains in the current browser profile unless the user explicitly exports a local JSON backup.
- The private library is a recoverable local privacy lock, not an unrecoverable strong-encryption claim. Resetting the lock preserves the content.

## 中文备用版

FutureContext 是本地优先的工具栏弹窗扩展，用于保存、分类、编辑、搜索和手动复制通用 Prompt、Skill、普通 AIGC Prompt、私密 AIGC Prompt 与终端指令。

测试方式：点击工具栏图标打开弹窗；在“通用 Prompt”或“Skill”中新建并保存条目；Skill 请粘贴包含 `name` 与 `description` YAML frontmatter 的完整 SKILL.md；点击复制只会复制文字，不会向网页自动填入内容。需要从 GitHub 收集时，先打开公开仓库具体的 SKILL.md 页面，再在 Skill 页点击“从当前 GitHub 页面收集”；扩展只读取该目录并保存，不执行任何脚本。需要后台整理时，在设置配置 Provider，按用户操作申请对应 API 域名权限，并用隐私锁密码加密 API Key；只有通用 Prompt 与 Skill 会在用户开启后发送，AIGC、终端指令与草稿永不发送。设置页支持本地 JSON 导入导出；导出时要求私密库已解锁，备份只写入用户选择的本地文件。

必需权限为 `storage`、`activeTab`、`scripting`、`alarms` 与 `permissions`：分别用于本地存储、用户主动的 GitHub 收集、后台整理调度和按用户操作申请特定站点权限。扩展没有自动网页扫描、账号、分析、远程代码执行、云同步、自动填表或开发者服务器。除用户主动的 GitHub 收集或已启用的 Provider 调用外，本地内容不会离开当前浏览器配置文件。私密库是可恢复的本地隐私锁，并非不可恢复的强加密承诺；重设访问锁不会删除内容，但会清除无法再解密的 Provider 配置。
