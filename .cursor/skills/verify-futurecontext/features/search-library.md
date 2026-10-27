# 搜索资料库

搜索让用户按标题或正文过滤当前类型的资料库，并区分无匹配与清空搜索后的完整列表。

## Sub-features

- `search-match` 按标题留下匹配条目。
- `search-empty` 对没有匹配的查询显示空列表，同时搜索框保留查询。
- `search-clear` 清空查询后恢复原来的条目。

## How to get to it (user POV)

- 在资料库工具栏的搜索框中输入。占位文字是「搜索标题或内容」，可访问名称是「搜索当前内容」。
- 搜索只作用于当前资产类型。切换标签会清空搜索。

## Driving it with control-futurecontext

Preconditions:

- `doctor` 输出 `ok`。
- 「通用 Prompt」列表已有标题 `发布清单`、正文 `标记并发布`。可先按 [新建通用 Prompt](./create-prompt.md) 保存它。
- 当前标签是「通用 Prompt」。

- **标题匹配。** 在搜索框输入 `发布`。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role searchbox --name "搜索当前内容" --value "发布"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"`。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser value --role searchbox --name "搜索当前内容"`，标准输出为 `发布`。
- **无匹配。** 把查询换成 `火山`。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role searchbox --name "搜索当前内容" --value "火山"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单" --absent` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无通用 Prompt"`。`browser value --role searchbox --name "搜索当前内容"` 的输出为 `火山`。
- **清空。** 把搜索框设为空字符串。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role searchbox --name "搜索当前内容" --value ""`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"`。`browser value` 的输出为空行。
- **证明。** 在标题匹配且搜索框仍为 `发布` 时取证。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/search-library/results.aria.txt"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/search-library/results.png"`。把 `browser value` 的输出一并留在同目录的 `query.txt`。截图能看到 FutureContext 和「发布清单」。

## Gotchas

- 无匹配时的文案也是「暂无通用 Prompt」，与全新空库相同。必须用 `browser value` 证明查询仍在，并用 `--absent` 证明原标题不在列表中。
- `browser wait --text` 读不到输入框的值。搜索词「火山」不会出现在 innerText 里。
- 搜索每次输入都会重绘列表。`fill` 一次写入整个查询。
- 切换到其他资产类型会清空搜索，并把最后使用的类型记入资料库。验证搜索期间不要切换标签。
