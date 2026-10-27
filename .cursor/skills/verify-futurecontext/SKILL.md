---
name: verify-futurecontext
description: "Drive the FutureContext Chrome extension library in an isolated profile and prove workspace behavior. Use when changing the tab workspace, prompt editor, search, asset tabs, or settings UI and a real browser proof is required."
---

# Verify FutureContext

FutureContext 是从仓库根目录加载的 Chrome / Edge Manifest V3 扩展，没有构建步骤。用户真正操作的主界面是扩展工作区：工具栏弹窗，以及同一页面以新标签页打开的资料库。本技能驱动后者。

就地取用面板、投递页、GitHub 同步和 Provider 配置不在默认验收实例里。不要把工作区结果说成这些入口已验证。

## Launch

在仓库根目录执行。每次验收使用新的 run id。两个 run id 可以使用不同的配置目录和调试端口并排运行。同一个 `FUTURECONTEXT_VERIFY_HOME` 已有 Chrome 时，`launch` 会拒绝再次启动。

```sh
export RUN_ID=proof1
export FUTURECONTEXT_VERIFY_HOME=/tmp/futurecontext-verify-$RUN_ID
export FUTURECONTEXT_VERIFY_EVIDENCE=/opt/cursor/artifacts/futurecontext-verify/$RUN_ID
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs launch
```

就绪标准是标准输出出现 `ready chrome-extension://<id>/src/ui/popup/popup.html?mode=tab`，并且页面正文含有 `通用 Prompt`，不含 `无法读取本地资料库`。

`launch` 直接执行 `/usr/bin/google-chrome-stable`，用独立 `--user-data-dir` 和临时调试端口。Chrome 154 会忽略 `--load-extension`，所以就绪后通过 DevTools 的 `Extensions.loadUnpacked` 加载仓库根目录。扩展 ID 必须等于该绝对路径的 Chrome 路径哈希。不要调用 `/usr/local/bin/google-chrome`：这个包装脚本固定使用 `/home/ubuntu/.config/google-chrome` 和端口 9222，会连上共享实例。只有在替代二进制会原样转发参数、并且不自带 user-data-dir 时，才设置 `FUTURECONTEXT_CHROME`。

`FUTURECONTEXT_VERIFY_HOME` 必须匹配 `/tmp/futurecontext-verify-<run-id>`。证据目录必须放在该目录之外。

## Doctor

任何交互看起来异常时，先运行只读检查。它不打开新页面，也不点击。

```sh
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs doctor
```

通过时打印 `ok`，并给出扩展名 `FutureContext`、与仓库 `manifest.json` 一致的版本、工作区 URL、配置目录、调试端口、Chrome 版本和扩展 ID。进程命令行必须包含本次 `--user-data-dir`。端口无响应、service worker 缺失、页面不是本次扩展，或正文含 `无法读取本地资料库` 时，退出码为 1。不要驱动未通过 doctor 的实例，也不要驱动不是这次 `launch` 启动的 Chrome。

## Drive

工作区页面是 `src/ui/popup/popup.html?mode=tab`，对应用户点击「在新标签页中打开」。标签页模式下，「在新标签页中打开」按钮本身是隐藏的。工具栏弹窗是同一 HTML，但不带 `mode=tab`；Chrome 不能在没有用户手势时打开 action popup，所以本技能不驱动弹窗壳。

先读 `features/README.md`，再按对应功能文件操作。命令从仓库根目录执行，并带上 Launch 里的两个环境变量。

```sh
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "+ 新建"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role textbox --name "标题（可选）" --value "发布清单"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "丢掉我" --absent
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser value --role searchbox --name "搜索当前内容"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser reload
```

`click` 和 `fill` 要求角色与可访问名称唯一匹配。名称来自 `aria-label`，否则来自包住控件的标签文字，否则来自可见文本。加 `--contains` 时名称按子串匹配。`click` 滚动到控件后发送真实鼠标事件。`fill` 聚焦控件、写入整个值，并派发一次 `input` 与一次 `change`。搜索框每次输入都会整页重绘，所以不要改成逐字键入。

`wait` 查看 `document.body.innerText`。输入框里的值不在 innerText 中，读取搜索词或标题字段用 `browser value`。`reload` 忽略缓存重新加载工作区，并等待页眉 `FutureContext` 出现。

稳定角色和名称：

| 用户看到的控件 | 命令 |
| --- | --- |
| 新建 | `--role button --name "+ 新建"` |
| 保存 | `--role button --name "保存"` |
| 返回 | `--role button --name "返回"` |
| 放弃草稿 | `--role button --name "放弃草稿"` |
| 标题 | `--role textbox --name "标题（可选）"` |
| 内容 | `--role textbox --name "内容"` |
| 搜索 | `--role searchbox --name "搜索当前内容"` |
| 通用 Prompt 标签 | `--role button --name "通用 Prompt"` |
| Skill 标签 | `--role button --name "Skill"` |
| AIGC Prompt 标签 | `--role button --name "AIGC Prompt"` |
| 指令标签 | `--role button --name "指令"` |
| 私密库 | `--role button --name "私密库"` |
| 返回普通 AIGC | `--role button --name "返回普通 AIGC"` |
| 设置 | `--role button --name "设置"` |
| 资料库标题行 | `--role button --name "发布清单" --contains` |

列表行的可访问名称包含标题、摘要和分类，例如 `发布清单 标记并发布 未分类`。打开某一条时使用 `--contains`。

## Evidence

证据写到 `$FUTURECONTEXT_VERIFY_EVIDENCE/<feature-id>/`。`snapshot` 与 `screenshot` 拒绝写进 `FUTURECONTEXT_VERIFY_HOME`。

```sh
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.aria.txt"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.png"
```

证明标准：

- 走用户能点击和输入的路径。不要调用页面内部保存函数，也不要直接写 `chrome.storage`。
- 同时留下动作结果和之后的状态。保存后的证明是重新加载工作区，列表仍显示该标题，而不是只看到「已保存」。该提示约 2.4 秒后隐藏。
- 截图要能看到页眉 FutureContext，以及被验证的标题或空状态。ARIA 快照要包含对应按钮或搜索框名称。
- `browser text` 是可见正文。输入值用 `browser value` 另记一行。
- 不在验收中填写 GitHub Token、同步 Token 或 Provider API Key。设置页只阅读可见标题并返回。
- 地图列出多个入口时，只驱动其中一个入口不能把其余入口记为已验证。

## Cleanup

只结束命令行包含本次 `--user-data-dir` 的 Chrome 进程，然后删除整个 `FUTURECONTEXT_VERIFY_HOME`。不要按进程名结束 Chrome。

```sh
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs cleanup
```

清理后确认 `$FUTURECONTEXT_VERIFY_EVIDENCE` 里的截图和 ARIA 快照仍在。失败的启动尝试也要执行 cleanup，避免留下调试端口和配置目录。

## Helpers

可执行助手是 `.cursor/skills/verify-futurecontext/control-futurecontext.mjs`。在仓库根目录调用：

```sh
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs launch
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs doctor
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser click --role button --name "设置"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser fill --role searchbox --name "搜索当前内容" --value "发布"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser value --role searchbox --name "搜索当前内容"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "发布清单"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser wait --text "丢掉我" --absent
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser reload
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser text
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser snapshot --aria --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.aria.txt"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser screenshot --path "$FUTURECONTEXT_VERIFY_EVIDENCE/create-prompt/list.png"
node .cursor/skills/verify-futurecontext/control-futurecontext.mjs cleanup
```

功能配方在 `features/`。界面变化后用 `/maintain-verification-skill` 更新地图。
