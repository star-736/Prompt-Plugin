# 发布指南与商店资料

本文合并发布步骤、商店文案与审核备注，按发布时需要的顺序阅读。以下文案对应当前 `manifest.json` 的 `0.3.0` 功能；发布新版本时先核对代码、版本与实际验证结果，再更新文案。

用户操作步骤见[配置指南](./CONFIGURATION.md)，独立可托管的正文见[隐私政策](./PRIVACY_POLICY.md)。这里只维护发布所需内容；控制台字段、可见性与素材要求以各商店当次页面为准。

## 打包与提交清单

1. 从当前源码生成发布包，让根目录 `manifest.json` 及完整 `src/`、`icons/`、`vendor/` 保持原有层级，包含 vendor 依赖许可证。不要打包 `.git/`、`node_modules/`、测试、开发脚本、凭据或个人备份。
2. 核对版本号，运行开发指南要求的检查；在隔离的 Edge / Chrome 配置中加载仓库根目录，验收新建、草稿、复制、删除、私密库、导入导出及本次涉及的可选功能。单元或模拟测试不能代替真实服务与原生目录授权验收；记录未执行的项目。
3. 将[隐私政策](./PRIVACY_POLICY.md)正文发布到稳定的公开 HTTPS 地址，不放入个人内容，将地址用于商店隐私政策字段。
4. 准备长期有效的支持邮箱、分类 `Productivity`、中文及需要的英文文案、截图。截图使用临时资产，不展示私密 Prompt、Token、密码或备份。
5. 在 Microsoft Edge Add-ons 的 Partner Center 或 [Chrome Web Store 开发者控制台](https://chromewebstore.google.com/devconsole)上传当前版本包，填写文案、隐私与权限说明、审核备注。两边独立提交与验收；仅凭链接分发时选择对应可见性选项。
6. 按实际行为填写数据使用声明：默认本地保存，用户可主动启用 Provider 调用、GitHub 收集及普通库同步，不能填写成“除导出外绝不传输内容”。审核后再分享商店链接。

旧文档提到的 `0.1.0` / `0.2.0` ZIP 是历史包记录，当前仓库没有这些发布包，不能拿旧文件名当作本版提交产物。

## 基本信息与权限说明

- Single purpose：`FutureContext is a local-first browser extension for collecting, organizing, and explicitly retrieving reusable prompts, Skills, AIGC prompts, and commands.`
- 远程代码：运行代码与 Markdown 依赖随扩展打包，Skill 脚本仅保存而不执行，不加载运行时 CDN。
- 必需权限与用途如下，与当前 manifest 一致。

| 权限 | 用途 |
| --- | --- |
| `storage` | 本地资产、草稿、设置与会话状态 |
| `unlimitedStorage` | Skill 文件包与同步基线的本地存储 |
| `activeTab` | 用户发起操作时获取当前标签页上下文 |
| `scripting` | 用户启用站点后加载取用脚本，以及 GitHub 收集所需的页面读取 |
| `alarms` | 后台 AI、同步与文件包恢复调度 |
| `contextMenus` | 用户选中文字后右键保存 |

可选站点权限按用户操作请求：GitHub 收集与同步、所配置 Provider，以及逐站启用的网页取用。`https://*/*` 声明允许用户选择自定义 HTTPS 服务和站点，不代表安装时获得所有站点权限。

需要英文解释宽泛可选权限时可使用：

> Provider endpoints and retrieval sites are user-configurable. The extension declares optional HTTPS host access and requests the relevant origins only when the user configures a Provider, starts GitHub collection or synchronization, or enables retrieval on a site. It does not request access to all sites at installation.

## 商店文案

### 中文短描述

本地收藏、整理和取用 Prompt、Skill、AIGC 灵感与指令，可选同步普通库。

### 中文完整描述

FutureContext 是本地优先的 Edge / Chrome 扩展，用于收藏和复用通用 Prompt、Skill、AIGC Prompt 与指令。你可以在工具栏弹窗或新标签页工作区中搜索、编辑、复制和管理内容，使用一级分类、置顶与常用排序，编辑草稿自动保留。

Skill 支持原始 SKILL.md 编辑、从公开 GitHub 主动收集文件包、Markdown 阅读与手动检查更新。选择并授权 Agent 目录后，可按条投递和撤回；撤回只删除属于本扩展的副本，收藏和外来副本保留。包内脚本仅保存，不执行。指令无标题、以正文为标识，仅保存在普通库，不发送给 AI。

在自己启用并授权的网站，你可以用 // 或快捷键打开取用面板，选择并确认后插入内容，不自动发送。网页选中文字也可通过右键保存为通用 Prompt。私密 AIGC 不出现在网页取用面板中。

需要 AI 整理时，可配置自己的 Provider，为已保存的通用 Prompt 补标题、为通用 Prompt 与 Skill 归类，人工修改优先；AIGC、指令、私密内容和草稿不发送给 AI。API Key 以隐私锁密码加密保存在本地。还可用独立 Token 将普通库和 Skill 文件同步到自己的个人私有 GitHub 仓库，私密库、草稿、凭据、使用记录和设备目录信息不参与。

FutureContext 无账号系统、自有服务器或使用统计上报。私密库是防止随手查看的可恢复本地隐私锁，不是强加密保险箱。完整 JSON 备份包含可读的私密内容；已上传的普通内容即使删除或移入私密库，也可能保留在 GitHub 历史中。请按实际需要启用外部服务并妥善存放备份。

### English short description

Collect, organize, and retrieve prompts, Skills, AIGC ideas, and commands locally, with optional ordinary-library sync.

### English full description

FutureContext is a local-first Edge / Chrome extension for reusable prompts, Skills, AIGC prompts, and commands. Manage content from the toolbar popup or a full-tab workspace with search, editing, explicit copying, first-level categories, pinning, usage-based sorting, and recoverable drafts.

Skills support raw SKILL.md editing, explicit public GitHub package collection, Markdown reading, and manual update checks. After you choose and authorize an Agent directory, you can deliver and recall individual Skills. Recall removes only copies belonging to FutureContext, preserving your collection and foreign copies. Package scripts are stored but never executed. Commands are content-first, have no title, remain in the ordinary library, and are never sent to AI.

On sites you explicitly enable and authorize, type // or use the shortcut to open a retrieval palette. Content is inserted only after you select and confirm it; messages are never sent automatically. Selected webpage text can also be saved as a generic prompt through the context menu. Private AIGC content is excluded from the palette.

Optionally configure your own Provider to generate generic-prompt titles and organize generic prompts and Skills, while preserving manual decisions. AIGC, commands, private content, and drafts are never sent to AI. API keys are encrypted locally with the privacy-lock password. A separate Token can synchronize your ordinary library and Skill files with your own personal private GitHub repository. Private content, drafts, credentials, usage data, and device directory information are excluded.

FutureContext has no accounts, developer-operated server, or usage telemetry. The private library uses a recoverable local privacy lock to prevent casual viewing; it is not a strong-encryption vault. Complete JSON backups contain readable private content. Previously uploaded ordinary content can remain in GitHub history after deletion or movement into the private library. Enable external services as needed and keep backups somewhere safe.

### 搜索词与截图

搜索词可选：`AI Prompt`、`提示词管理`、`SKILL.md`、`AIGC`、`本地优先`、`Prompt library`、`FutureContext`。

截图可展示四个页签与分类、Skill 阅读与文件树、网页取用面板、私密库锁定状态。尺寸、数量与文案长度按对应控制台要求调整。

## 审核备注

以下英文内容可用于审核测试说明；按当次提交内容与实际可测试配置调整。不要在备注里写真实 Token、API Key 或私人资产。

### English

FutureContext is a local-first extension for reusable prompts, Skills, AIGC prompts, and commands. It supports a toolbar popup and a full-tab workspace. Optional external features require explicit user configuration and relevant host permissions.

How to test:

1. Open the toolbar popup. Create a generic prompt or command, save it, then search and copy it. Generic-prompt titles are optional; commands have no title. Drafts survive popup closure.
2. Create a Skill using SKILL.md with YAML frontmatter containing name and description. Alternatively, open a public GitHub SKILL.md file page and use the Skill tab's collection action. Package files are stored locally and never executed. Read saved Markdown in the full-tab workspace and manually check GitHub updates from the Skill detail.
3. Open AIGC Prompt and enter the private library. Set a password of at least six characters on first use. Closing the workspace locks the private library. Resetting the privacy lock preserves assets and clears Provider configuration.
4. Optionally configure a Provider in Settings, save an API Key encrypted with the privacy-lock password, select it, and test after session unlock. Enable background organization separately. Only saved ordinary generic prompts and Skills are sent; private content, AIGC, commands, and drafts are excluded.
5. Enable retrieval on a chosen HTTPS site and grant permission. Type // or use the configured shortcut in an input, select a result, and confirm insertion. No message is sent automatically. Private content and commands are excluded. Selected text can be saved as a generic prompt through the context menu.
6. In Settings, choose and authorize an Agent directory, then explicitly deliver a saved Skill. Recall removes only a copy marked as belonging to that asset; foreign copies are preserved.
7. Export and import a local JSON backup. Export requires private-library unlock; the backup includes private content in readable form. Import merges without replacing existing items.
8. Optionally configure an existing personal private GitHub repository with a dedicated Contents read/write Token, enable synchronization, and inspect its status. Only ordinary assets, categories, and Skill files are synchronized. Private content, drafts, credentials, usage records, and device delivery state are excluded. Existing Git history is not rewritten.

Required permissions are storage, unlimitedStorage, activeTab, scripting, alarms, and contextMenus. They support local data and package storage, user-triggered page access and retrieval, background scheduling, and selection capture. Optional host access is granted for the configured Provider, GitHub features, or explicitly enabled retrieval sites. Runtime code is bundled, Skill scripts are never executed, and there is no developer-operated server, automatic page collection, automatic message sending, or analytics. External data transfer occurs only through user-enabled features described above. The private library is a recoverable privacy lock, not a strong-encryption vault.

中文操作步骤统一见[配置指南](./CONFIGURATION.md)，当前功能及边界见[产品规格](./specs/SPEC.md)，不再维护另一份重复的中文审核流程。
