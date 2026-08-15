# FutureContext 发布清单

## 已准备

- `release/FutureContext-0.1.0-edge.zip`：仅包含扩展运行所需文件，且 `manifest.json` 位于 ZIP 根目录。
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
