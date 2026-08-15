# FutureContext 商店资料

以下文字基于当前 `0.1.0` 的实际功能编写，可直接复制到 Microsoft Edge Add-ons 的 Store listings 页面。

## 基本信息

- 分类：Productivity
- 语言：建议先填写 `zh-CN`；如 Partner Center 依据包的默认语言要求 `en-US`，同时使用下方英文版本。
- 支持方式：填写你自己可长期接收邮件的支持邮箱。
- 网站：可选。隐私政策托管后，可填写同一站点或项目主页。

## 中文短描述

本地保存、分类与复制 AI Prompt、SKILL.md 和私密 AIGC 灵感的浏览器工具。

## 中文完整描述

FutureContext 是一个本地优先的浏览器扩展，用来保存那些现在想到、未来还会复用的 AI 内容。你可以在工具栏弹窗里创建、分类、搜索、编辑、复制和删除通用 Prompt、单文件 `SKILL.md` 与 AIGC Prompt；复制内容后，再由你自己粘贴到任意 AI 网页或本地工具中。

Skill 适合保存带 YAML frontmatter 的完整 `SKILL.md`，FutureContext 会在保存时检查其中是否包含 `name` 和 `description`。通用 Prompt 和普通 AIGC Prompt 可以建立一级分类；私密 AIGC Prompt 使用单独的可恢复本地隐私锁，并以扁平列表保存，避免在锁定时泄露标题或数量。

FutureContext 不提供账号、云同步、网页读取、自动填入或模型调用。你的内容保存在当前浏览器配置文件的本地扩展存储中，除非你主动导出 JSON 备份，否则不会发送给开发者或第三方。私密库用于避免他人随手打开扩展查看内容，并非不可恢复的强加密保险箱；导出的备份也可能包含可读的私密内容，请自行妥善保存。

## English short description

Save, organize, and copy reusable AI prompts, single-file SKILL.md files, and private AIGC ideas locally.

## English full description

FutureContext is a local-first browser extension for AI material you want to keep now and reuse later. From a toolbar popup, you can create, organize, search, edit, copy, and delete reusable prompts, complete single-file `SKILL.md` files, and AIGC prompts. Copying is always explicit: FutureContext copies text only, and you decide where to paste it.

Skills are stored as complete `SKILL.md` content with YAML frontmatter. FutureContext checks for the required `name` and `description` fields when a Skill is saved. Generic prompts and regular AIGC prompts support first-level categories. Private AIGC prompts live in a separate, flat library behind a recoverable local privacy lock, so titles and item counts are not exposed while the library is locked.

FutureContext has no accounts, cloud sync, webpage reading, automatic text injection, or AI model calls. Content stays in local extension storage within the current browser profile unless you explicitly export a JSON backup. The private library is intended to prevent casual viewing on a shared computer; it is not an unrecoverable strong-encryption vault. An exported backup can contain readable private content and should be kept somewhere safe.

## 搜索词（可选）

`AI Prompt`、`提示词管理`、`SKILL.md`、`AIGC`、`本地优先`、`Prompt library`、`FutureContext`

## 截图建议

1. 三个顶部标签与通用 Prompt 的分类列表。
2. Skill 编辑页，展示 YAML frontmatter 校验提示。
3. 私密库锁定页，展示“不泄露条目标题”的状态。

不要在截图中展示真实私密 Prompt、密码或导出的备份内容。
