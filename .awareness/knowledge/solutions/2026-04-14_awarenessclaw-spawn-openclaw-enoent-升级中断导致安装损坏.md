---
id: kc_mnyhzuda_6c30fb02
category: problem_solution
confidence: 0.95
tags: [awarenessclaw, enoent, npm, openclaw, upgrade]
created_at: 2026-04-14T10:47:59.615Z
---

# AwarenessClaw spawn openclaw ENOENT — 升级中断导致安装损坏

npm install -g openclaw 中断后，包目录只剩空 dist/ 没有 package.json 和入口文件，symlink 断裂。修复：chat-cli-executor.ts 和 register-channel-config-handlers.ts 的 ENOENT 正则扩展为匹配 openclaw（不仅是 npx），register-setup-handlers.ts 安装前检测损坏目录并自动清理。参考 openclaw#28074（npm update 留下 stale content-hashed 文件）和 #51199（tarball out-of-order entries）。
