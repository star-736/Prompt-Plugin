# 文档导航

先读根目录 [README](../README.md) 安装并了解功能，再按目的选择下面的文档，无需逐份阅读。

## 使用与配置

| 想做什么 | 阅读位置 |
| --- | --- |
| 配置 GitHub、AI、网页取用或 Agent 目录 | [配置与使用指南](./CONFIGURATION.md) |
| 理解普通库、私密库、投递等词的含义 | [项目术语](./CONTEXT.md) |
| 了解内容如何保存、发送与保护 | [隐私政策](./PRIVACY_POLICY.md) |

## 开发与发布

| 想做什么 | 阅读位置 |
| --- | --- |
| 查当前功能、交互与边界 | [当前产品规格](./specs/SPEC.md) |
| 查同步格式、合并、撤回与调度 | [同步技术规格](./specs/SPEC_GITHUB_SYNC.md) |
| 修改代码与运行验证 | [开发指南](../AGENTS.md) |
| 打包、准备商店文案和审核说明 | [发布指南](./PUBLISHING_CHECKLIST.md) |
| 理解为什么这样设计 | 下方设计决策 |
| 回顾阶段变化和未实现的早期方向 | [阶段历史](./specs/HISTORY.md) |

## 设计决策

- 私密与凭据：[库边界](./adr/0001-library-first-encrypted-vault.md)、[明文备份](./adr/0002-single-plaintext-backup.md)、[Provider 会话](./adr/0003-encrypt-provider-keys-with-session-unlock.md)
- Skill：[GitHub 文件包](./adr/0004-save-github-skills-as-versioned-packages.md)、[明确投递](./adr/0008-explicit-skill-delivery-to-agent-directories.md)、[外来副本](./adr/0009-reconcile-bound-skill-directories-without-claiming-foreign-copies.md)、[本地版本判定](./adr/0010-match-local-skills-by-yaml-name-and-skill-md.md)
- 取用与类型：[站点取用](./adr/0005-user-triggered-in-place-insertion-on-enabled-sites-only.md)、[指令](./adr/0007-terminal-command-as-fourth-asset-type.md)
- 数据：[兼容演进](./adr/0006-additive-schema-evolution-without-version-gating.md)、[跨上下文写锁](./adr/0011-serialize-database-writes-across-extension-contexts.md)、[私有 GitHub 同步](./adr/0012-private-github-library-sync.md)、[文件包恢复](./adr/0013-recover-unreferenced-skill-packages-under-the-database-lock.md)

## 文档维护约定

术语只解释概念，配置指南写操作步骤，产品规格写当前规则，技术规格与 ADR 写实现约束和决策理由。新增功能时更新对应文档，在其它位置用摘要和链接引用。

阶段历史和 ADR 保留当时背景，不代表所有旧限制或未来设想仍适用；当前状态看产品规格，并以实际代码和验证结果为准。商店文案、审核说明和隐私政策是面向外部的独立材料，保留各自必需的说明。
