# 只有用户明确投递的 Skill 才写入 Agent 目录，且必须可撤回

收集 Skill 只进入 FutureContext 冷库，默认不写入 Claude / Cursor / Codex / Hermes Agent 等 Agent 的 skills 目录。浏览器扩展不能静默写用户主目录，因此首次投递要用户亲自选择该 Agent 的 skills 文件夹；之后按条投递，撤回只删除带 FutureContext 投递标记且属于该条目的目录。不采用全库自动同步，因为各 Agent 启动时会把目录里的 Skill 元数据收进发现表，会破坏“先看看、不注入上下文”的边界。
