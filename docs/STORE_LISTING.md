# FutureContext 商店资料

以下文字基于当前 `0.2.0` 的实际功能编写，可直接复制到 Microsoft Edge Add-ons 的 Store listings 页面。

## 基本信息

- 分类：Productivity
- 语言：建议先填写 `zh-CN`；如 Partner Center 依据包的默认语言要求 `en-US`，同时使用下方英文版本。
- 支持方式：填写你自己可长期接收邮件的支持邮箱。
- 网站：可选。隐私政策托管后，可填写同一站点或项目主页。

## 中文短描述

本地保存、整理与复制 AI Prompt、Skill 和私密 AIGC 灵感的浏览器工具。

## 中文完整描述

FutureContext 是一个本地优先的浏览器扩展，用来保存那些现在想到、未来还会复用的 AI 内容。你可以在工具栏弹窗里创建、分类、搜索、编辑、复制和删除通用 Prompt、Skill 与 AIGC Prompt；复制内容后，再由你自己粘贴到任意 AI 网页或本地工具中。

Skill 可以直接粘贴完整 `SKILL.md`，也可以在公开 GitHub 的具体 `SKILL.md` 页面主动收集整个所在目录。FutureContext 会检查 `name` 和 `description`，保存文件树、资源与脚本，但绝不执行脚本。通用 Prompt 可设置可选标题并建立一级分类；私密 AIGC Prompt 使用单独的可恢复本地隐私锁，并以扁平列表保存，避免在锁定时泄露标题或数量。

FutureContext 不提供账号、云同步或自动填入。你可以选择配置自己的 OpenAI、OpenCode Go、DeepSeek、OpenRouter 或 OpenAI 兼容 Provider，让后台为通用 Prompt 补标题和归类；AIGC Prompt 与草稿永不发送。Provider API Key 由你的隐私锁密码加密后本地保存。GitHub 与 Provider 的站点权限仅在你主动发起操作时请求。除这些你主动启用的调用外，内容不会发送给开发者或第三方。私密库用于避免他人随手打开扩展查看内容，并非不可恢复的强加密保险箱；导出的备份也可能包含可读的私密内容，请自行妥善保存。

## English short description

Save, organize, and copy reusable AI prompts, Skills, and private AIGC ideas locally.

## English full description

FutureContext is a local-first browser extension for AI material you want to keep now and reuse later. From a toolbar popup, you can create, organize, search, edit, copy, and delete reusable prompts, Skills, and AIGC prompts. Copying is always explicit: FutureContext copies text only, and you decide where to paste it.

Skills can be pasted as complete `SKILL.md` content or explicitly collected from a public GitHub `SKILL.md` page with its containing directory. FutureContext checks the required `name` and `description` fields, saves the file tree and resources, and never executes package scripts. Generic prompts support optional titles and first-level categories. Private AIGC prompts live in a separate, flat library behind a recoverable local privacy lock, so titles and item counts are not exposed while the library is locked.

FutureContext has no accounts, cloud sync, or automatic text injection. You may configure your own OpenAI, OpenCode Go, DeepSeek, OpenRouter, or OpenAI-compatible Provider for background organization of Generic Prompts and Skills; AIGC prompts and drafts are never sent. API keys are encrypted locally with the private-library password. GitHub and Provider access are requested only when you explicitly use them. Otherwise, content stays in local extension storage within the current browser profile unless you explicitly export a JSON backup. The private library is intended to prevent casual viewing on a shared computer; it is not an unrecoverable strong-encryption vault. An exported backup can contain readable private content and should be kept somewhere safe.

## 搜索词（可选）

`AI Prompt`、`提示词管理`、`SKILL.md`、`AIGC`、`本地优先`、`Prompt library`、`FutureContext`

## 截图建议

1. 三个顶部标签与通用 Prompt 的分类列表。
2. Skill 编辑页，展示 YAML frontmatter 校验提示。
3. 私密库锁定页，展示“不泄露条目标题”的状态。

不要在截图中展示真实私密 Prompt、密码或导出的备份内容。
