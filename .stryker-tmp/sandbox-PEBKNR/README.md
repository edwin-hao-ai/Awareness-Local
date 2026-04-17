# @awareness-sdk/local

[![npm](https://img.shields.io/npm/v/@awareness-sdk/local?color=7b68ee)](https://www.npmjs.com/package/@awareness-sdk/local) [![LongMemEval R@5](https://img.shields.io/badge/LongMemEval_R%405-95.6%25-brightgreen)](https://arxiv.org/abs/2410.10813) [![Discord](https://img.shields.io/discord/1354000000000000000?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.com/invite/nMDrT538Qa)

Local-first AI agent memory system. No account needed.

## Benchmark: LongMemEval (ICLR 2025)

Awareness Memory is evaluated on **[LongMemEval](https://arxiv.org/abs/2410.10813)** — the industry standard benchmark for long-term conversational memory, published at ICLR 2025. 500 human-curated questions across 5 core capabilities.

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

### Leaderboard

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

### Accuracy by Question Type

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

Zero LLM calls. Runs on Apple M1 8GB in 14 minutes. [Reproducible benchmark scripts →](https://github.com/edwin-hao-ai/Awareness/tree/main/benchmarks/longmemeval)

---

## Install

```bash
npm install -g @awareness-sdk/local
```

## Quick Start

```bash
# Start the local daemon
awareness-local start
```

```javascript
import { record, retrieve } from "@awareness-sdk/local/api";

await record({ content: "Refactored auth middleware." });
const result = await retrieve({ query: "What did we refactor?" });
console.log(result.results);
```

## Perception (Record-Time Signals)

When you call `record()`, the response may include a `perception` array -- automatic signals the system surfaces without you asking. These are computed from pure DB queries (no LLM calls), adding less than 50ms of latency.

**Signal types:**

| Type | Description |
|------|-------------|
| `contradiction` | New content conflicts with an existing knowledge card |
| `resonance` | Similar past experience found in memory |
| `pattern` | Recurring theme detected (e.g., same category appearing often) |
| `staleness` | A related knowledge card hasn't been updated in a long time |
| `related_decision` | A past decision is relevant to what you just recorded |

```javascript
const result = await awareness_record({
  action: "remember",
  content: "Decided to use RS256 for JWT signing",
  insights: { knowledge_cards: [{ title: "JWT signing", category: "decision", summary: "..." }] }
});

if (result.perception) {
  for (const signal of result.perception) {
    console.log(`[${signal.type}] ${signal.message}`);
    // [pattern] This is the 4th 'decision' card -- recurring theme
    // [resonance] Similar past experience: "JWT auth migration"
  }
}
```

## License

Apache-2.0
