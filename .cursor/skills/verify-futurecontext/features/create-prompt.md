# 新建通用 Prompt

新建通用 Prompt 让用户写下一个标题和正文，保存后在资料库列表看到它；未保存的草稿可以放弃，放弃后列表不出现该标题。

## Sub-features

- `create-open` 从资料库工具栏打开空白编辑器。
- `create-save` 保存标题和正文，并在重新加载后仍显示。
- `create-cancel` 放弃未保存草稿，列表不保留该标题。

## How to get to it (user POV)

- 在「通用 Prompt」列表点击 `+ 新建`。列表为空时，空状态里还有 `新建通用 Prompt`，两者都打开同一编辑器。
- 保存后回到列表，点击该条目的标题行可再次打开。
- 编辑器页眉的 `返回` 在有未保存内容时要求确认放弃草稿。

## Driving it with control-futurecontext

Preconditions:

- `doctor` 输出 `ok`，页面 URL 含 `popup.html?mode=tab`。
- 资料库中还没有标题 `发布清单` 或 `丢掉我`。
- 当前标签是「通用 Prompt」。若不是，先点击 `通用 Prompt`。

- **打开编辑器。** 点击 `+ 新建`。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "+ 新建"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "新建通用 Prompt"`。页面出现标题为「新建通用 Prompt」的编辑器。
- **填写内容。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role textbox --name "标题（可选）" --value "发布清单"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role textbox --name "内容" --value "标记并发布"`。
- **保存。** 点击 `保存`。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "保存"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"`。列表显示标题「发布清单」和摘要「标记并发布」。
- **确认持久化。** 重新加载工作区。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser reload`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"`。重新加载后的列表仍显示该标题。
- **放弃草稿。** 再次打开编辑器，把标题写成 `丢掉我`，然后返回并确认放弃。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "+ 新建"`、`node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "新建通用 Prompt"`、`node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role textbox --name "标题（可选）" --value "丢掉我"`、`node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "返回"`、`node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "放弃未保存的更改"`、`node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "放弃草稿"`。然后运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "丢掉我" --absent` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"`。列表保留「发布清单」，没有「丢掉我」。
- **证明。** 在重新加载后的列表上取证。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.aria.txt"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.png"`。两份产物都能看到 FutureContext 和「发布清单」。

## Gotchas

- 列表为空时同时存在 `+ 新建` 和 `新建通用 Prompt`。列表非空时只保留 `+ 新建`。配方使用 `+ 新建`。
- 「已保存」提示会很快隐藏。以重新加载后的列表标题为准。
- 未修改就点击 `返回` 不会询问放弃。要验证放弃，必须先让标题或正文不同于打开时的值。
- 确认框关闭后，`放弃草稿` 按钮不再可见。不要在返回资料库之后再找它。
- 打开列表行时名称包含摘要和分类。使用 `--role button --name "发布清单" --contains`。
- 验收配置目录删除后，这次保存的条目随之消失。证据文件留在 `FUTURECONTEXT_VERIFY_EVIDENCE`。
