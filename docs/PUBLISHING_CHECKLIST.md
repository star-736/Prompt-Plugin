# FutureContext 发布清单

## 已准备

- `release/FutureContext-0.1.0-edge.zip`：仅包含扩展运行所需文件，且 `manifest.json` 位于 ZIP 根目录。（旧包，对应 0.1.0 代码）
- `release/FutureContext-0.2.0-chrome.zip`：当前 0.2.0 代码的完整运行包（11 个文件，含 `background.js`、`ai-organizer.js`、`github-skill.js`、`package-store.js`），`manifest.json` 位于 ZIP 根目录，条目路径为正斜杠。Chrome Web Store 与 Edge Add-ons 均可使用此包；Edge 侧上传前可改名为对应版本号。
- `docs/STORE_LISTING.md`：中英文商店介绍、搜索词和截图建议。
- `docs/PRIVACY_POLICY.md`：可发布的隐私政策正文。
- `docs/CERTIFICATION_NOTES.md`：审核测试备注。

## Partner Center 操作顺序

1. 在 **Packages** 上传 `release/FutureContext-0.1.0-edge.zip`。
2. 在 **Availability** 选择 **Hidden**，并选择希望朋友所在的市场；审核后通过商店链接分发。
3. 在 **Properties** 选择 `Productivity`，填写长期有效的支持邮箱；网站字段可填隐私政策或项目主页。
4. 在 **Privacy** 如实填写：
   - Single purpose：`FutureContext is a local-first browser extension for saving, organizing, editing, and explicitly copying reusable AI prompts, complete SKILL.md files, and AIGC prompt ideas.`
   - `storage` justification：`The storage permission is required to save user-created prompts, SKILL.md content, categories, drafts, and the local private-library lock state in chrome.storage.local.`
   - Remote code：选择 **No, I am not using remote code**。
   - Data usage：按页面的逐项措辞如实确认：没有向开发者或第三方传输、出售或共享用户内容；内容只留在本地，除非用户主动导出。
   - Privacy Policy URL：先将 `PRIVACY_POLICY.md` 托管到公开 HTTPS 地址，再粘贴该地址。
5. 在 **Store listings** 粘贴 `STORE_LISTING.md` 的文案，上传 Logo。现有 `icons/futurecontext-c.png` 为 128×128，可用；商店更推荐 300×300 的版本。
6. 在提交页粘贴 `CERTIFICATION_NOTES.md` 的英文备注并提交审核。

## 提交前人工检查

- 在一个干净的 Edge 配置文件中加载扩展，完整走一遍新建、编辑、复制、删除、私密库设置/重设锁、导入和导出。
- 确认商店文案不把“私密库”描述为强加密或不可恢复保险箱。
- 确认隐私政策 URL、支持邮箱和商店截图均不含私人 Prompt、密码或备份文件。
- 不要把 `release` ZIP 当作普通附件发给朋友安装；审核通过后分享 Hidden 商店链接。

## Chrome Web Store（给朋友用）

Edge 的审核结果与 Chrome 完全独立，两边都要各自提交。当前代码只用标准 `chrome.*` API（Manifest V3），Chrome 无需任何改动。

1. 在 `chrome://extensions` 打开开发者模式，加载本项目的解压目录（不是 ZIP），完整走一遍功能，确认 Chrome 下无报错。
2. 到 [Chrome Web Store 开发者控制台](https://chromewebstore.google.com/devconsole) 用 Google 账号注册，支付一次性 5 美元注册费（需可国际支付的信用卡）。
3. New item 上传 `release/FutureContext-0.2.0-chrome.zip`。
4. Store listing：文案直接复用 `STORE_LISTING.md`；Chrome 强制要求至少 1 张 1280×800 截图；语言选 zh-CN（可加 en）。
5. Privacy practices（对应 Edge 的 Privacy 页）：
   - Single purpose 复用 Edge 的英文表述。
   - 宽泛权限说明：`optional_host_permissions` 里的 `https://*/*` 会触发书面说明，建议写“Provider endpoints are user-configurable (any OpenAI-compatible origin), so origins cannot be enumerated at build time. The specific origin is requested at runtime via `chrome.permissions.request()` only when the user configures or uses that Provider, or starts GitHub Skill collection. The extension never requests all sites at once.”
   - Data usage 如实勾选：不收集、不出售、不用于无关用途（与 Edge 口径一致）。
   - Privacy Policy URL 复用 Edge 审核时托管的同一 HTTPS 地址。
6. Distribution 选择 **Unlisted（未列出）**：商店搜索不到，只有拿到直链的人可安装，等同 Edge 的 Hidden 模式；朋友点链接安装后有自动更新。Unlisted 同样需要过审。
7. 提交时把 `CERTIFICATION_NOTES.md` 的英文版贴进审核备注。新账号叠加宽泛 host 权限，首次审核可能要几天到几周。
8. 不推荐替代方案：Trusted testers 需要建 Google 群组并让朋友全部入群；直接发 ZIP 让朋友开发者模式加载则没有自动更新且每次启动有提示。Chrome 已禁止商店外 CRX 安装。
