---
id: kc_mntxn4ml_e709608f
category: insight
confidence: 0.85
tags: [electron, main-process, http, daemon-api]
created_at: 2026-04-11T06:07:09.357Z
---

# Electron 主进程调 Node http 模块而非 fetch 做 localhost daemon API 调用

在 main.ts switchDaemonWorkspace() 中用 http.request({host:'127.0.0.1',port:37800,...}) 而非 fetch。理由：(1) Electron 30+ 的 fetch 需要 net-fetch 包或更新运行时；(2) 直接用 http 更清晰控制 timeout/error/destroy；(3) main.ts 已 import http 模块。Promise 封装内置 timeout:10000 + req.on('error')/timeout 保证从不抛错，只返回 { ok, error } 结构。
