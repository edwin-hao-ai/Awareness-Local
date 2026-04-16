---
id: kc_mnth1u5a_72a55864
category: problem_solution
confidence: 0.95
tags: [vitest, jsdom, fetch, mock, testing]
created_at: 2026-04-10T22:22:42.142Z
---

# vitest jsdom 环境 fetch 挂起需要 mock

useWikiData hook 用 fetch() 调 daemon REST API。在 vitest jsdom 环境中 fetch 会挂起导致所有测试 timeout。修复：在 beforeEach 中用 globalThis.fetch = vi.fn().mockResolvedValue({ok:true, json:()=>Promise.resolve({...})}) mock 全局 fetch。
