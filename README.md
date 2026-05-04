# Awareness Local

<p align="center">
  <strong>Languages:</strong> English | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/awareness-wordmark-dark.svg" />
    <img src="assets/branding/awareness-wordmark.svg" alt="Awareness Local — Persistent Memory for AI Coding Agents" width="760" />
  </picture>
</p>

<p align="center">
  <a href="https://arxiv.org/abs/2410.10813"><img src="https://img.shields.io/badge/LongMemEval_R%405-95.6%25-brightgreen?style=for-the-badge" alt="LongMemEval R@5 95.6%" /></a>
  <a href="https://awareness.market/"><img src="https://img.shields.io/badge/Website-awareness.market-0EA5E9?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website" /></a>
  <a href="https://awareness.market/docs"><img src="https://img.shields.io/badge/Docs-awareness.market%2Fdocs-14B8A6?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Docs" /></a>
  <a href="https://discord.com/invite/nMDrT538Qa"><img src="https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-2563EB?style=for-the-badge" alt="License Apache 2.0" /></a>
</p>

<p align="center">
  <img src="assets/branding/local-20s.gif" alt="Awareness Local" style="width:min(1200px,100%);height:auto;" />
</p>

**Give your AI agent persistent memory. One command. No account. Works offline.**

Awareness Local is a local-first MCP memory server for AI coding agents. It gives Cursor, Claude Code, Copilot, Cline, and other MCP IDEs persistent memory, hybrid semantic + keyword retrieval, and reusable knowledge cards for long-running software projects.

It runs a lightweight daemon on your machine, stores memory as Markdown, indexes recall with SQLite FTS5 + embeddings, and keeps your AI workflow fast, explainable, and offline-ready.

```bash
npx @awareness-sdk/setup
```

That's it. Your AI agent now remembers everything across sessions.

---

## Why Awareness Local

AI coding agents lose context between sessions. Awareness Local provides cross-session memory recall so agents can continue work without re-explaining architecture, past decisions, pending tasks, and implementation constraints.

- Persistent memory for AI coding agents
- Local-first MCP server with offline support
- Hybrid retrieval (keyword + semantic)
- Knowledge card extraction for decisions, solutions, and risks

## Quick Start

```bash
npx @awareness-sdk/setup
```

Then open your IDE and start coding. Awareness tools become available for recall, record, and session initialization.

## Popular Use Cases

- Long-running codebase migrations across many sessions
- Team handoffs where AI should remember prior implementation context
- Personal coding workflows that need durable preferences and conventions
- Multi-agent setups that share decision history and task memory

## FAQ

### Does Awareness Local work offline?

Yes. Local mode works fully offline with memory stored on your machine.

### Where is data stored?

Memory is stored as Markdown in `.awareness/`, with a local SQLite index for retrieval.

### Do I need a cloud account?

No. Cloud sync is optional and can be enabled later.

### Which IDEs are supported?

Any MCP-compatible IDE, including Cursor, Claude Code, Copilot, Cline, Windsurf, and others.

## Navigation

- [Benchmark: LongMemEval](#benchmark-longmemeval-iclr-2025)
- [Supported IDEs](#supported-ides-13)
- [How It Works](#how-it-works)
- [MCP Tools](#mcp-tools-available-in-your-ide)
- [Cloud Sync](#cloud-sync-optional)
- [SDK & Plugin Ecosystem](#sdk--plugin-ecosystem)

## Benchmark: LongMemEval (ICLR 2025)

Evaluated on **[LongMemEval](https://arxiv.org/abs/2410.10813)** — the industry standard benchmark for long-term conversational memory. 500 human-curated questions across 5 core capabilities.

```
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   Awareness Memory — LongMemEval Benchmark Results           ║
║   ─────────────────────────────────────────────────           ║
║                                                              ║
║   Benchmark:  LongMemEval (ICLR 2025)                       ║
║   Dataset:    500 human-curated questions                    ║
║   Variant:    LongMemEval_S (~115k tokens per question)      ║
║                                                              ║
║   ┌─────────────────────────────────────────────────┐        ║
║   │                                                 │        ║
║   │   Recall@1    77.6%    (388 / 500)              │        ║
║   │   Recall@3    91.8%    (459 / 500)              │        ║
║   │   Recall@5    95.6%    (478 / 500)  ◀ PRIMARY   │        ║
║   │   Recall@10   97.4%    (487 / 500)              │        ║
║   │                                                 │        ║
║   └─────────────────────────────────────────────────┘        ║
║                                                              ║
║   Method:     Hybrid RRF (BM25 + Semantic Vector Search)     ║
║   Embedding:  all-MiniLM-L6-v2 (384d)                       ║
║   LLM Calls:  0  (pure retrieval, no generation cost)        ║
║   Hardware:   Apple M1, 8GB RAM — 14 min total               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

```
┌─────────────────────────────────────────────────────────────┐
│          Long-Term Memory Retrieval — R@5 Leaderboard       │
│          LongMemEval (ICLR 2025, 500 questions)             │
├─────────────────────────────────┬───────────┬───────────────┤
│  System                         │  R@5      │  Note         │
├─────────────────────────────────┼───────────┼───────────────┤
│  MemPalace (ChromaDB raw)       │  96.6%    │  R@5 only *   │
│  ★ Awareness Memory (Hybrid)    │  95.6%    │  Hybrid RRF   │
│  OMEGA                          │  95.4%    │  QA Accuracy  │
│  Mastra (GPT-5-mini)            │  94.9%    │  QA Accuracy  │
│  Mastra (GPT-4o)                │  84.2%    │  QA Accuracy  │
│  Supermemory                    │  81.6%    │  QA Accuracy  │
│  Zep / Graphiti                 │  71.2%    │  QA Accuracy  │
│  GPT-4o (full context)          │  60.6%    │  QA Accuracy  │
├─────────────────────────────────┴───────────┴───────────────┤
│  * MemPalace 96.6% is Recall@5 only, not QA Accuracy.      │
│    Palace hierarchy was NOT used in the evaluation.         │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│     Awareness Memory — R@5 by Question Type                 │
│                                                             │
│  knowledge-update        ████████████████████████████ 100%  │
│  multi-session           ███████████████████████████▋  98.5%│
│  single-session-asst     ███████████████████████████▌  98.2%│
│  temporal-reasoning      █████████████████████████▊    94.7%│
│  single-session-user     ████████████████████████▎     88.6%│
│  single-session-pref     ███████████████████████▏      86.7%│
│                                                             │
│  Overall                 █████████████████████████▉    95.6%│
│                                                             │
│  ┌───────────────────────────────────────────────┐          │
│  │  Ablation Study                               │          │
│  │  ─────────────────────────────────────────    │          │
│  │  Vector-only:   92.6%  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░     │          │
│  │  BM25-only:     91.4%  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░     │          │
│  │  Hybrid RRF:    95.6%  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░  ★  │          │
│  │                        Hybrid = +3% over any  │          │
│  │                        single method alone    │          │
│  └───────────────────────────────────────────────┘          │
│                                                             │
│  arxiv.org/abs/2410.10813          awareness.market         │
└─────────────────────────────────────────────────────────────┘
```

Zero LLM calls. [Reproducible benchmark scripts →](https://github.com/edwin-hao-ai/Awareness/tree/main/benchmarks/longmemeval)

---

## What It Does

**Before:** Every session starts from scratch. You re-explain the codebase, re-justify decisions, watch the agent redo work.

**After:** Your agent says *"I remember you were migrating from MySQL to PostgreSQL. Last session you completed the schema changes and had 2 TODOs remaining..."*

```
Session 1                          Session 2
┌─────────────────────────┐       ┌─────────────────────────┐
│ Agent: "What database?" │       │ Agent: "I remember we   │
│ You: "PostgreSQL..."    │       │ chose PostgreSQL for     │
│ Agent: "What framework?"│  →    │ JSON support. You had    │
│ You: "FastAPI..."       │       │ 2 TODOs left. Let me     │
│ (repeat every session)  │       │ continue from there."    │
└─────────────────────────┘       └─────────────────────────┘
```

---

## Supported IDEs (13+)

| IDE | Auto-detected | Plugin |
|-----|:---:|:---:|
| **Claude Code** | ✅ | [`awareness-memory`](https://github.com/edwin-hao-ai/Awareness-SDK/tree/main/claudecode) |
| **Cursor** | ✅ | via MCP |
| **Windsurf** | ✅ | via MCP |
| **OpenClaw** | ✅ | [`@awareness-sdk/openclaw-memory`](https://www.npmjs.com/package/@awareness-sdk/openclaw-memory) |
| **Cline** | ✅ | via MCP |
| **GitHub Copilot** | ✅ | via MCP |
| **Codex CLI** | ✅ | via MCP |
| **Kiro** | ✅ | via MCP |
| **Trae** | ✅ | via MCP |
| **Zed** | ✅ | via MCP |
| **JetBrains (Junie)** | ✅ | via MCP |
| **Augment** | ✅ | via MCP |
| **AntiGravity (Jules)** | ✅ | via MCP |

---

## How It Works

```
Your IDE / AI Agent
    │
    │  MCP Protocol (localhost:37800)
    ▼
┌────────────────────────────────────┐
│  Awareness Local Daemon            │
│                                    │
│  Markdown files    → Human-readable, git-friendly
│  SQLite FTS5       → Fast keyword search
│  Local embedding   → Semantic search (optional: npm i @huggingface/transformers)
│  Knowledge cards   → Auto-extracted decisions, solutions, risks
│  Web Dashboard     → http://localhost:37800/
│                                    │
│  Cloud sync (optional)             │
│  → One-click device-auth           │
│  → Bidirectional sync              │
│  → Semantic vector search          │
│  → Team collaboration              │
└────────────────────────────────────┘
```

### Your Data

All memories stored as **Markdown files** in `.awareness/` — human-readable, editable, git-friendly:

```
.awareness/
├── memories/
│   ├── 2026-03-22_decided-to-use-postgresql.md
│   ├── 2026-03-22_fixed-auth-bug.md
│   └── ...
├── knowledge/
│   ├── decisions/postgresql-over-mysql.md
│   └── solutions/auth-token-refresh.md
├── tasks/
│   └── open/implement-rate-limiting.md
└── index.db  (search index, auto-rebuilt)
```

---

## Features

### MCP Tools (available in your IDE)

| Tool | What it does |
|------|-------------|
| `awareness_init` | Load session context — recent knowledge, tasks, rules |
| `awareness_recall` | Search memories — progressive disclosure (summary → full) |
| `awareness_record` | Save decisions, code changes, insights — with knowledge extraction |
| `awareness_lookup` | Fast lookup — tasks, knowledge cards, session history, risks |
| `awareness_get_agent_prompt` | Get agent-specific prompts for multi-agent setups |

### Progressive Disclosure (Smart Token Usage)

Instead of dumping everything into context, Awareness uses a two-phase recall:

```
Phase 1: awareness_recall(query, detail="summary")
  → Lightweight index (~80 tokens each): title + summary + score
  → Agent reviews and picks what's relevant

Phase 2: awareness_recall(detail="full", ids=[...])
  → Complete content for selected items only
  → No truncation, no wasted tokens
```

### Web Dashboard

Visit `http://localhost:37800/` to browse memories, knowledge cards, tasks, and manage cloud sync.

### Cloud Sync (Optional)

Connect to [Awareness Cloud](https://awareness.market) for:
- Semantic vector search (100+ languages)
- Cross-device real-time sync
- Team collaboration
- Memory marketplace

```bash
npx @awareness-sdk/setup --cloud
# Or click "Connect to Cloud" in the dashboard
```

---

## SDK & Plugin Ecosystem

Awareness Local is part of the Awareness ecosystem:

| Package | For | Install |
|---------|-----|---------|
| **[Awareness Local](https://github.com/edwin-hao-ai/Awareness-Local)** | Local daemon + MCP server | `npx @awareness-sdk/setup` |
| **[Python SDK](https://pypi.org/project/awareness-memory-cloud/)** | `wrap_openai()` / `wrap_anthropic()` interceptors | `pip install awareness-memory-cloud` |
| **[TypeScript SDK](https://www.npmjs.com/package/@awareness-sdk/memory-cloud)** | `wrapOpenAI()` / `wrapAnthropic()` interceptors | `npm i @awareness-sdk/memory-cloud` |
| **[OpenClaw Plugin](https://www.npmjs.com/package/@awareness-sdk/openclaw-memory)** | Auto-recall + auto-capture | `openclaw plugins install @awareness-sdk/openclaw-memory` |
| **[Claude Code Plugin](https://github.com/edwin-hao-ai/Awareness-SDK/tree/main/claudecode)** | Skills + hooks | `/plugin marketplace add edwin-hao-ai/Awareness-SDK` → `/plugin install awareness-memory@awareness` |
| **[Setup CLI](https://www.npmjs.com/package/@awareness-sdk/setup)** | One-command setup for 13+ IDEs | `npx @awareness-sdk/setup` |

Full SDK docs: [awareness.market/docs](https://awareness.market/docs)

---

## Requirements

- Node.js 18+
- Any MCP-compatible IDE

No Python, no Docker, no cloud account needed.

## License

Apache 2.0

---

### Tags & Integration
**IDE Support:** [Cursor](https://cursor.com), [Windsurf](https://codeium.com/windsurf), [Trae](https://www.trae.sh), [Zed](https://zed.dev), VS Code, JetBrains.
**Compatible with:** OpenClaw, AutoGPT, LangChain, MetaGPT.
**Key Technology:** OMP (Open Memory Protocol), LatentMAS, Shared Thought Space, One-click Deployment.
**Focus:** Solving AI "Lobster Memory" (Long-term memory loss), Automating complex workflows, Simplifying Agent setup.
