# FutureContext

本地优先的 Edge / Chrome 扩展，用于收集、整理和取用通用 Prompt、Skill、AIGC Prompt 与指令。无需账号，默认保存在当前浏览器中，可选同步普通库到自己的 GitHub 私有仓库。

## 安装与开始使用

1. 打开 `edge://extensions`（Chrome 使用 `chrome://extensions`），开启“开发人员模式”。
2. 点击“加载解压缩的扩展”，选择本项目根目录（包含 `manifest.json`）。
3. 将 FutureContext 固定到工具栏，点击图标即可开始使用。

扩展无需构建。点击右上角“在新标签页中打开”，可在更大的工作区中编辑和阅读 Skill。

## 主要功能

- **资产管理**：搜索、编辑、复制、置顶与常用排序；通用 Prompt、Skill 和指令支持一级分类。编辑草稿自动保留，支持 JSON 备份与合并导入。
- **Skill 收藏与投递**：编辑单文件 `SKILL.md`，或从公开 GitHub 的具体 `SKILL.md` 页面收集完整文件包；支持 Markdown 阅读、文件树与手动检查更新。选择并授权 Agent 目录后，可按条投递和撤回，撤回只删除能确认属于本扩展的副本。包内脚本仅保存，不执行。
- **网页取用与保存**：启用并授权站点后，在输入框中用 `//` 或 `Alt+Shift+F` 打开取用面板，确认后插入内容，不自动发送；选中文字后可通过右键菜单“保存到 FutureContext”收藏。
- **可选 AI 整理**：在设置中配置 Provider 并开启后台整理，为已保存的通用 Prompt 补标题、为通用 Prompt 与 Skill 归类，保留人工修改。支持 OpenAI、OpenCode Go、DeepSeek、OpenRouter 和自定义 OpenAI 兼容接口；私密内容、草稿、AIGC 与指令不发送给 AI。
- **私密 AIGC**：普通与私密库之间可手动迁移；私密库使用可恢复的本地隐私锁，关闭弹窗后重新锁定。
- **可选 GitHub 同步**：连接自己的个人私有仓库，同步普通库及 Skill 文件。支持自动与手动同步，断网仍可本地保存，冲突保留副本。

具体配置见[配置与使用指南](./docs/CONFIGURATION.md)，按需阅读 GitHub Token、私有仓库同步、AI 整理、网页取用、Agent 投递与备份步骤。

## 隐私说明

- 私密库用于防止他人随手打开扩展查看内容，不是强加密保险箱；能访问浏览器配置文件的人仍可能读取本地内容或重设隐私锁。
- **完整 JSON 备份包含私密内容**，请妥善存放。GitHub 同步只包含普通资产、分类和 Skill 文件，不含私密库、草稿、密钥、使用记录和设备目录信息；删除或移入私密库不会清除已有 Git 历史。
- Provider API Key 加密保存，解锁后在当前浏览器会话供后台使用；GitHub Token 保存在本地扩展存储中，不写入备份，能访问浏览器配置文件的人可以读取。

## 开发与验证

使用原生 JavaScript ES Modules、HTML、CSS 与 Manifest V3，无应用构建步骤。CI 使用 Node.js 24。

```sh
npm ci
npm run check
npm test
npm run coverage
```

`check` 检查 JavaScript 语法、模块与页面资源引用及入口路径；覆盖率最低要求为 92%。

源码位于 `src/`，按 `core`（模型与资料库）、`platform`（浏览器存储）、`features`（功能服务）、`background`（后台）、`content`（网页取用）、`ui`（页面）组织；测试位于 `test/`。

打包内容与商店资料见[发布指南](./docs/PUBLISHING_CHECKLIST.md)。

## 更多文档

[文档导航](./docs/README.md)按使用、开发、发布与历史整理了阅读入口；查当前功能规则可直接看[产品规格](./docs/specs/SPEC.md)。
