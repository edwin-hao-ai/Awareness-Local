---
id: kc_mnz9y18b_fb1bbf44
category: workflow
confidence: 0.85
tags: []
created_at: 2026-04-14T23:50:24.443Z
---

# handleWebUi 安全加固：URL-decode + symlink + NUL

原版只防 .. 和绝对路径。新增：decodeURIComponent 拦截 %2e%2e；NUL byte 拦截；malformed URL encoding catch return 400；fs.realpathSync(filePath) + fs.realpathSync(webDir) 比较 startsWith(realWebDir + path.sep) 防 symlink 逃逸（攻击场景：攻击者在 web/onboarding/ 创建 symlink 指向 /etc/passwd）。10 个测试覆盖。
