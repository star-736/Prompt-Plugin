# 打开设置

打开设置让用户从资料库页眉进入设置，看到隐私锁和就地取用等本机选项，再返回原来的资料库。

## Sub-features

- `settings-open` 从页眉齿轮打开设置页。
- `settings-visible` 能看到隐私锁和就地取用的说明。
- `settings-back` 返回资料库，不提交任何凭据。

## How to get to it (user POV)

- 点击页眉右侧、可访问名称为「设置」的按钮。
- 在设置页点击 `返回` 回到资料库。

## Driving it with control-futurecontext

Preconditions:

- `doctor` 输出 `ok`。
- 当前可以是任意已加载的资料库页面。返回后的断言使用进入设置之前就已经存在的正文，例如空库的「暂无通用 Prompt」，或已保存的「发布清单」。

- **打开设置。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "设置"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "隐私锁"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "就地取用"`。设置页标题为「设置」。
- **返回。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "返回"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "通用 Prompt"`。资料库标签重新出现。
- **证明。** 在仍停在设置页、尚未点击返回时取证。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/open-settings/settings.aria.txt"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/open-settings/settings.png"`。产物能看到 FutureContext、「隐私锁」和「就地取用」。取证后再执行返回。

## Gotchas

- 设置页包含同步仓库、同步 Token 和 GitHub Skill 收集 Token 输入框。不要填写或保存这些字段。未提交的同步表单也会被记成草稿。
- 不要点击「开启」后台 AI、「整理」、导出或导入。本配方只确认设置页能够打开和返回。
- 标签页工作区里没有「在新标签页中打开」按钮。页眉上可点击的是「返回资料库」品牌按钮和「设置」。
- 「隐私锁」在未设置时的说明是「未设置」。不要把这行文字当成已经创建了密码。
