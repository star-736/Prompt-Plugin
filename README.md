# FutureContext for Edge

FutureContext 是一个本地优先的 Edge / Chrome 扩展，用于保存、分类、编辑和复制：

- 通用 Prompt
- 单文件或从 GitHub 收集的包式 `SKILL.md`
- 普通与私密 AIGC Prompt
- 指令（终端 / CLI / AI Agent 命令、浏览器指令及快捷键速查等）

完整产品范围见 [一期规格](./docs/specs/SPEC.md)、[二期规格](./docs/specs/SPEC_PHASE2.md)、[三期规格](./docs/specs/SPEC_PHASE3.md)、[四期规格](./docs/specs/SPEC_PHASE4.md) 与 [私有仓库同步规格](./docs/specs/SPEC_GITHUB_SYNC.md)，术语与隐私边界见 [CONTEXT.md](./docs/CONTEXT.md)。

## 当前能力

### 新标签页中的 Skill 阅读

点击右上角「在新标签页中打开」，进入 Skill 标签后，左侧选择 Skill，右侧默认完整渲染根目录 `SKILL.md`。名称与描述单独展示，正文保留标题、列表、表格和代码块；宽屏右侧显示可折叠文件树，文件夹按层级展开，包内 Markdown 链接可以直接打开已保存的辅助文件；窄屏时文件树移到正文上方，首次打开默认收起。单文件 Skill 点击「编辑 Skill」修改，GitHub Skill 点击「管理 Skill」进入分类、投递和更新等操作。窄屏自动上下排列。

Markdown 渲染依赖随扩展打包在 `vendor/` 中，发布时必须包含 `src/ui/popup/skill-reader.js` 和整个 `vendor/` 目录；不从 CDN 加载脚本。

### GitHub 收集认证

在扩展「设置 → GitHub Token（可选）」粘贴个人访问令牌并保存；再次填写可替换，点击「移除 Token」恢复匿名请求。Token 用于提高公开仓库的 GitHub API 额度，并让失败原因更清楚。保存仅验证格式，不向 GitHub 发起请求；额度、权限或过期问题会在收集/更新时提示。可从 [GitHub Token 设置](https://github.com/settings/tokens) 创建令牌。

Token 明文只存在此浏览器配置文件的扩展存储中，不写入资料库或导出备份，不在表单中回显。卸载扩展或清除扩展数据会删除它；能使用此浏览器配置文件的人可以读取它。它只发送到 `https://api.github.com`，请求不跟随重定向。

遇到额度耗尽或临时限流时，提示会在服务器提供相关响应头时显示本地时间的重试时间；网络失败、401、403 和 404 分别给出不同原因。限流不会自动重试，也不做重复请求合并。规则参考 [GitHub API 限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)。

### 可选 GitHub 私有仓库同步

在「设置 → GitHub 私有仓库同步」填写已有的个人私有仓库 `owner/repo` 与专用细粒度 Token（仅授权该仓库，Contents 读写），启用后保存。扩展先检查仓库仍为个人私有仓库，再合并本地与远端普通库，写入 `.futurecontext/library.json`；不创建仓库，不覆盖整个资料库。此 Token 与公开 Skill 收集 Token 独立保存，表单不回显；「移除同步设置」删除同步配置和专用 Token。

同步覆盖普通的通用 Prompt、Skill（含关联文件包）、AIGC Prompt、指令与普通分类。私密资产及分类、草稿、密码、Provider 配置/API Key、Token、取用统计、设备投递记录和目录句柄不参与同步。同步格式使用明确字段白名单，不使用包含私密内容的完整备份格式。普通 AIGC 移入私密库后，远端发布不可复活的撤回标记，其它设备移除普通副本；离线编辑冲突仅保留为该设备的本地私密 AIGC 副本。再次主动移出私密库使用新 ID，可重新同步。

同步表单的未保存输入（仓库、专用 Token 与开关）自动暂存在当前浏览器会话中。关闭弹窗去复制其它内容后重新打开，会恢复到设置页继续填写；Token 草稿使用密码框，已正式保存的 Token 不回显。暂存不改变同步配置、不发起同步，不写入资料库或备份。保存成功、移除设置或点击「放弃暂存」后清除；重启浏览器、重新加载或更新扩展也会清除。可从设置页点击「在新标签页中打开」，在保持打开的设置页填写。

自动同步在相关保存后约 7 秒尝试；后台休眠时由 30 秒报警补偿，并每 5 分钟检查。设备休眠或浏览器调度可能延后执行。打开工作区也会检查；可随时点击「立即同步」。关闭自动同步保留手动同步。断网不影响本地保存，设置显示失败并可重试；自动模式会在后续检查重试。编辑冲突保留独立副本，删除冲突保留撤回/删除及编辑副本；GitHub SHA 并发冲突重新读取，最多尝试三次。

单个同步 JSON 文件上限为 15 MiB（包括 Base64 文件包与删除标记）；超限明确失败并保留本地数据。Contents API 不返回大文件正文时使用 Git blob 读取。扩展申请 `unlimitedStorage`，用于本地 Skill 文件和精确同步基线；同步基线保留上一次确认的普通记录，避免仅靠时间戳判断冲突。GitHub 保留普通 Git 提交历史，删除或移入私密库不改写历史。它是可选的普通资料同步，不增加私密库的本地访问锁强度。

### 资产管理

- 工具栏弹窗内完成四类资产的搜索、一级分类、编辑、复制与永久删除。
- 指令用于收集终端 / CLI / AI Agent 命令、浏览器指令（如 `chrome://restart`）及快捷键速查等；内容优先、无需标题，支持一级分类与搜索，正文以等宽字体展示，复制即为原始命令。新资料库预设“终端指令”“浏览器指令”两个普通分类，可重命名、删除或继续创建分类；已有资料库保持原样。它默认保存在本地，可选参与用户私有 GitHub 仓库同步，永不发送给 AI Provider。
- Skill 可直接编辑带 YAML frontmatter 的 `SKILL.md`，也可从公开 GitHub 的具体 `SKILL.md` 页面收集同目录完整包；包内脚本仅保存、绝不执行。收集默认不写入任何 Agent 目录；可在详情页按条投递到 Claude / Cursor / Codex / Hermes Agent 等 skills 文件夹，并随时撤回（只删带标记的副本，库内收藏保留）。绑定目录后按 YAML name 对照磁盘：外来同名 Skill 显示为“目录里已有”；SKILL.md 不同则可更新本地，撤回不会动它。
- 通用 Prompt 标题可选；配置后台 AI 后可无感补全标题和归入分类。AIGC Prompt 与指令永不发送给 AI Provider。
- 支持 OpenAI、OpenCode Go、DeepSeek、OpenRouter 和自定义 OpenAI 兼容 Provider；API Key 由私密库密码加密保存，并只在当前浏览器会话解锁后供后台使用。
- AIGC Prompt 可在普通库和私密库之间明确迁移。
- 私密库使用可恢复的本地隐私锁：关闭弹窗即重新锁定；重设密码不会删除内容。
- 编辑草稿自动保留，连续输入时合并待写入草稿；正式保存会等待正在进行的草稿写入。保存期间显示进度并防止重复提交，失败时保留输入与持久错误提示，可点击重试。
- 支持本地 JSON 完整备份；导入只合并新内容，不覆盖已有条目。
- 无需账号系统，默认仅本地保存；可选同步到用户自己的 GitHub 私有仓库，无自动填入网页输入框；GitHub 收集和用户配置的 Provider 调用都必须由用户主动启用并授予对应站点权限。

## 隐私边界

私密库的目标是防止他人随手打开 FutureContext 查看 AIGC 内容。它不是不可恢复的强加密保险箱：拥有浏览器配置文件或本机账户访问权的人，仍可能重设隐私锁或访问浏览器本地数据。

完整备份文件包含私密内容。导出前请确认存放位置可靠。

## 安装到 Edge

1. 打开 `edge://extensions` 并开启“开发人员模式”。
2. 点击“加载解压缩的扩展”。
3. 选择本项目根目录（包含 `manifest.json` 的目录）。
4. 将 FutureContext 固定到 Edge 工具栏后点击图标即可使用。

Chrome 同样可通过 `chrome://extensions` 加载。

## 开发与验证

```sh
npm ci
npm run check
npm test
npm run coverage
```

项目无需构建即可加载，使用原生 JavaScript、Manifest V3、`chrome.storage`、IndexedDB 与 Web Crypto。GitHub 包资源保存在 IndexedDB；API Key 使用 PBKDF2 + AES-GCM 加密后本地保存。

源码按职责组织：`src/ui/` 为扩展页面，`src/background/` 为后台消息和任务，`src/content/` 为网页取用，`src/core/` 为数据模型和业务规则，`src/features/` 为 AI、GitHub 与 Agent 功能，`src/platform/` 为浏览器存储及扩展路径。测试保存在 `test/`，产品规格在 `docs/specs/`，设计决策在 `docs/adr/`。

Skill 文件包与资产 JSON 分开持久保存。收集、更新、导入和同步在资料库写锁内先写包、再保存引用；中断或清理失败留下的无引用包，会在后台启动与五分钟恢复报警中重新核验引用并清理。已引用、进行中的包和更新版本的只读资料库受到保护；清理失败不影响已确认保存。浏览器调度可能延后清理，这不提供跨库原子事务，详见 [包恢复设计](./docs/adr/0013-recover-unreferenced-skill-packages-under-the-database-lock.md)。

`npm run check` 递归检查源码、测试和工具脚本的语法及本地模块/页面资源引用，并校验 manifest 入口与共享路径一致。覆盖率检查包含整个 `src/`，最低行覆盖率为 92%；CI 使用 Node.js 24。

发布包必须包含根目录 `manifest.json`、完整 `src/`、`icons/` 与 `vendor/`（含依赖许可证），并保持目录层级。开发用的 `node_modules/`、`test/`、`scripts/` 和 `.git/` 不需要打包。
