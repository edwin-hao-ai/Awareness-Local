---
id: kc_mnth1u5a_49bbe1c6
category: pitfall
confidence: 0.95
tags: [react, hooks, infinite-loop, useref]
created_at: 2026-04-10T22:22:42.142Z
---

# useRef(fn).current 防止 useEffect 无限循环

当 useMemoryData hook 接收的 loadLearningStatus/loadPromotionProposals 回调是每次渲染新建的 async () => {} 时，会导致 reloadMemoryData useCallback 依赖变化 → useEffect 重跑 → 无限循环。修复：用 useRef(async () => {}).current 创建渲染间稳定引用。
