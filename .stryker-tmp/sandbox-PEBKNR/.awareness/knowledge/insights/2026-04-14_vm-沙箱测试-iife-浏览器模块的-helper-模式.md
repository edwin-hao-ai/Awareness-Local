---
id: kc_mnz9y18b_2800e265
category: insight
confidence: 0.85
tags: []
created_at: 2026-04-14T23:50:24.444Z
---

# vm 沙箱测试 IIFE 浏览器模块的 helper 模式

sdks/local/test/helpers/onboarding-env.mjs：用 node:vm createContext + runInContext 加载 IIFE 脚本测试。makeSandbox 提供 window/document/fetch/localStorage shim。makeLocalStorage({enabled:false}) 模拟隐私模式。比较 vm 内的数组用 JSON.stringify 而非 deepEqual（vm 上下文 prototype 不同会过不了严格比较）。模式可复用给其他 IIFE 模块测试。
