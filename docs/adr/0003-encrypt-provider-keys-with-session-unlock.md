# 用私密库密码加密 Provider API Key，并按浏览器会话解锁

FutureContext 没有账号、同步或自有后端，因此用户配置的云端 Provider API Key 必须只保存在本地。Key 使用私密库密码通过 PBKDF2 与 AES-GCM 加密后持久化；解密后的 Key 只在 `chrome.storage.session` 中保留当前浏览器会话，供 MV3 后台服务处理保存后的整理队列。私密库密码重设时，旧 Key 不可再解密，因此清空 Provider 配置，但绝不删除 Prompt、Skill 或私密 AIGC 内容。

这不是对拥有浏览器配置文件访问权的攻击者的强密码保险箱；它避免长期明文存储和每次后台请求都要求用户输入密码之间的操作冲突。未来若引入原生钥匙串或服务端凭据代理，应迁移凭据层，而不改变资产数据。
