# FutureContext 验收地图

这个目录是 FutureContext 工作区用户可见行为的验收来源。先读本索引，再按对应功能文件操作。

## Baseline preconditions

- 在仓库根目录设置 `FUTURECONTEXT_VERIFY_HOME=/tmp/futurecontext-verify-$RUN_ID` 与 `FUTURECONTEXT_VERIFY_EVIDENCE`，后者不能位于前者内部。
- 运行 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs launch`。新的 run id 得到空资料库，当前标签是「通用 Prompt」。
- 运行 `doctor`，要求输出 `ok`、扩展名 FutureContext、与仓库 manifest 一致的版本，以及 `popup.html?mode=tab`。
- 只驱动本次 launch 启动的实例。同一 HOME 已有 Chrome 时不要再次 launch。
- 不同 run id 可以并排运行。不要连接 `/home/ubuntu/.config/google-chrome` 或端口 9222 上的共享 Chrome。

## Driving conventions

- 除非功能文件另写前置条件，否则从空资料库的「通用 Prompt」开始。
- 使用可访问名称，不用坐标或 Tab 顺序。
- 命令按字面执行，保留引号和标志。
- 浏览器动作通过 `node .cursor/skills/verify-futurecontext/control-futurecontext.mjs browser` 执行。
- 正文用 `browser text` 与 `browser wait --text`。输入框的值用 `browser value`。
- 清理验收配置目录，保留证据目录中的截图和 ARIA 快照。

## Proof and skip reporting

- 记录用户动作和动作之后的状态，不只记录最终画面。
- UI 证明包含一份 ARIA 快照和一张能看到 FutureContext 页眉的截图。
- 保存类证明要重新加载工作区后再次看到该条目。
- 每份产物注明功能 ID 和实际使用的入口。
- 入口达不到时，写明尝试的命令和未满足的前置条件。
- 不要把另一个入口的结果记成这个入口已验证。

## Feature entry contract

每个功能文件以 H1 开头，并用一段话说明用户可见行为。随后按顺序只有四个 H2：`Sub-features`、`How to get to it (user POV)`、`Driving it with control-futurecontext`、`Gotchas`。

## Features

- [新建通用 Prompt](./create-prompt.md) 覆盖从工具栏新建、保存、重新加载后仍在，以及放弃未保存草稿。
- [搜索资料库](./search-library.md) 覆盖标题匹配、无匹配，以及清空搜索后恢复列表。
- [切换资产类型](./switch-library.md) 覆盖四个类型标签，以及未设置隐私锁时的私密库入口。
- [打开设置](./open-settings.md) 覆盖从页眉进入设置并返回资料库，不提交凭据。
