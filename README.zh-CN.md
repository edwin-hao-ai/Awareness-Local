# Awareness Local

<p align="center">
  <strong>语言:</strong> 简体中文 | <a href="./README.md">English</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/awareness-wordmark-dark.svg" />
    <img src="assets/branding/awareness-wordmark.svg" alt="Awareness Local — 面向 AI 编程代理的持久记忆" width="760" />
  </picture>
</p>

<p align="center">
  <a href="https://arxiv.org/abs/2410.10813"><img src="https://img.shields.io/badge/LongMemEval_R%405-95.6%25-brightgreen?style=for-the-badge" alt="LongMemEval R@5 95.6%" /></a>
  <a href="https://awareness.market/"><img src="https://img.shields.io/badge/官网-awareness.market-0EA5E9?style=for-the-badge&logo=googlechrome&logoColor=white" alt="官网" /></a>
  <a href="https://awareness.market/docs"><img src="https://img.shields.io/badge/文档-awareness.market%2Fdocs-14B8A6?style=for-the-badge&logo=readthedocs&logoColor=white" alt="文档" /></a>
  <a href="https://discord.com/invite/nMDrT538Qa"><img src="https://img.shields.io/badge/Discord-加入社区-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/许可证-Apache%202.0-2563EB?style=for-the-badge" alt="许可证 Apache 2.0" /></a>
</p>

<p align="center">
  <img src="assets/branding/local-20s.gif" alt="Awareness Local" style="width:min(1200px,100%);height:auto;" />
</p>

**给你的 AI 编程助手加上持久记忆。一个命令即可，本地优先，无需账号。**

Awareness Local 是一个面向 AI 编程代理的本地优先 MCP 记忆服务。它为 Cursor、Claude Code、Copilot、Cline 等 MCP IDE 提供跨会话持久记忆、语义+关键词混合检索，以及可复用的知识卡片能力。

Awareness Local 是一个面向 AI 编程代理的本地优先记忆系统。它在你的机器上运行轻量守护进程，以 Markdown 方式存储记忆，使用 FTS5 + 向量混合检索，并通过 MCP 协议接入 IDE。

```bash
npx @awareness-sdk/setup
```

就是这么简单。你的 AI 代理可以跨会话记住上下文。

---

## 核心能力

- 本地优先记忆存储（Markdown，可读、可编辑、可 Git 管理）
- 混合检索（SQLite FTS5 + 语义向量）
- MCP 工具接入多种 IDE
- 自动提炼知识卡片（决策、方案、风险）
- Web 控制台： http://localhost:37800/
- 可选云同步（跨设备与团队协作）

## 常用工具

- awareness_init: 加载会话上下文
- awareness_recall: 召回记忆（摘要/全文两阶段）
- awareness_record: 记录决策、代码变更与洞察
- awareness_lookup: 快速查任务、知识卡片、会话历史
- awareness_get_agent_prompt: 多代理场景下获取提示词

## 要求

- Node.js 20+
- 任意支持 MCP 的 IDE

## 链接

- 官网： https://awareness.market/
- 文档： https://awareness.market/docs
- Discord： https://discord.com/invite/nMDrT538Qa
- 英文完整说明： [README.md](./README.md)

## 许可证

Apache 2.0
