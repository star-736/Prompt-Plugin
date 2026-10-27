# 切换资产类型

切换资产类型让用户在通用 Prompt、Skill、AIGC Prompt 和指令之间查看各自的列表。AIGC 下还可以进入私密库入口；尚未设置隐私锁时，看到的是设置隐私锁，而不是私密内容。

## Sub-features

- `switch-tabs` 打开四个类型标签并显示各自的空状态或已有列表。
- `switch-private-gate` 从 AIGC 打开私密库设置入口，再返回普通 AIGC。

## How to get to it (user POV)

- 点击页签 `通用 Prompt`、`Skill`、`AIGC Prompt` 或 `指令`。
- 在 AIGC Prompt 中点击 `私密库`。未设置隐私锁时出现「设置隐私锁」。
- 在隐私锁页面点击 `返回普通 AIGC`。

## Driving it with control-futurecontext

Preconditions:

- `doctor` 输出 `ok`。
- 使用刚 launch 的空资料库。不要在这个配方里创建条目或设置密码。
- 若前面的配方已经保存过通用 Prompt，空状态断言改为列表中仍能看到该标题，不要再等待「暂无通用 Prompt」。

- **通用 Prompt。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "通用 Prompt"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无通用 Prompt"`。
- **Skill。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "Skill"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无Skill"`。
- **AIGC。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "AIGC Prompt"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "普通"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无AIGC Prompt"`。
- **私密库入口。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "私密库"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "设置隐私锁"`。不要填写密码。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "返回普通 AIGC"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无AIGC Prompt"`。
- **指令。** 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "指令"`，再运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "暂无指令"`。
- **证明。** 停在指令空状态时取证。运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/switch-library/command.aria.txt"` 和 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/switch-library/command.png"`。产物能看到 FutureContext 和「暂无指令」。验证结束后点击 `通用 Prompt`，让后续配方从通用库开始。

## Gotchas

- 切换标签会写入最后使用的类型。重新加载后打开的是该类型，不一定回到「通用 Prompt」。
- Skill 列表一旦有条目，标签页工作区会打开阅读布局，而不是与空库相同的列表。本配方只覆盖空 Skill 列表。
- 「暂无Skill」「暂无AIGC Prompt」「暂无指令」中间没有空格。
- 私密库入口在未设置隐私锁时不是内容列表。不要把「设置隐私锁」记成私密内容已可见。
- 不要在这个配方里提交隐私锁密码。
