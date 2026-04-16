/* Awareness Onboarding — i18n dictionary (en + zh)
 * Loaded as a plain <script> after index.html's own LOCALES are defined.
 * Merges onboarding keys into the existing LOCALES object so t() picks them up.
 */
// @ts-nocheck

(function () {
  if (typeof window === 'undefined' || !window.LOCALES) {
    console.warn('[onboarding] LOCALES not ready — i18n not merged');
    return;
  }

  const EN = {
    // Status chip (persistent widget)
    'onb.chip.local_mode': 'Local mode',
    'onb.chip.cloud_on': 'Cloud synced',
    'onb.chip.connect_cta': 'Connect cloud →',

    // Privacy settings (Settings → Privacy)
    'privacy.title': '📊 Usage Analytics',
    'privacy.toggle_label': 'Send anonymous usage data',
    'privacy.toggle_desc': 'Helps us prioritize features. Opt-in. No memory content, file paths, queries, or IPs collected.',
    'privacy.enabled': 'Enabled',
    'privacy.disabled': 'Disabled',
    'privacy.install_id': 'Installation ID',
    'privacy.view_recent': 'View recent events',
    'privacy.delete_data': 'Delete my data',
    'privacy.confirm_delete': 'Delete all telemetry data for this installation? This clears the local queue and requests server-side deletion.',
    'privacy.deleted_msg': 'Local queue cleared. Server-side delete requested.',

    // Step 1 Welcome
    'onb.welcome.title': 'Welcome to Awareness',
    'onb.welcome.subtitle': "Your AI agents' persistent memory layer",
    'onb.welcome.bullet_index': 'Index your current project',
    'onb.welcome.bullet_recall': 'See how recall works',
    'onb.welcome.bullet_connect': 'Connect to Claude Code / OpenClaw',
    'onb.welcome.bullet_cloud': '(Optional) Enable cloud sync',
    'onb.welcome.cta': "Let's Start",
    'onb.welcome.skip_all': 'Skip setup, explore myself',
    'onb.welcome.telemetry_label': 'Send anonymous usage analytics',
    'onb.welcome.telemetry_hint': 'Enabled by default to help us improve. We never collect memory content, file paths, queries, or IP addresses. Toggle off anytime in Settings → Privacy.',

    // Step 2 Scan
    'onb.scan.title': "Let's index your first project",
    'onb.scan.current_dir': 'Current directory',
    'onb.scan.intro': "We'll scan code files (40+ languages), markdown docs, and build a symbol graph + Wiki.",
    'onb.scan.privacy': 'This runs 100% locally. Nothing leaves your machine.',
    'onb.scan.cta': 'Scan Now',
    'onb.scan.progress': 'Scanning… {pct}%',
    'onb.scan.summary': 'Found {files} files · {symbols} symbols · {wiki} wiki pages',

    // Step 3 First Recall
    'onb.recall.title': 'Try asking your memory something',
    'onb.recall.hint': 'Click a suggestion below (tailored to your project):',
    'onb.recall.input_ph': 'Ask anything…',
    'onb.recall.results': 'Results',
    'onb.recall.no_results': 'No matches yet — add a few memories first',
    'onb.recall.next': 'Next: See Wiki',
    // Suggestion templates
    'onb.q.readme': 'Summarize the README',
    'onb.q.architecture': "What's the architecture of this project?",
    'onb.q.wiki_page': 'Tell me about {title}',
    'onb.q.lang': 'What {lang} files do we have?',
    'onb.q.decisions': 'What decisions were made here?',
    'onb.q.tag': 'Tell me about {tag}',
    'onb.q.recent_decision': 'What was decided recently?',
    'onb.q.recent_pitfall': 'Any recent pitfalls to watch out for?',
    // Result type labels
    'onb.type.decision': 'decision',
    'onb.type.problem_solution': 'fix',
    'onb.type.pitfall': 'pitfall',
    'onb.type.insight': 'insight',
    'onb.type.workflow': 'how-to',
    'onb.type.key_point': 'key point',
    'onb.type.workspace_file': 'file',
    'onb.type.workspace_wiki': 'wiki',
    'onb.type.workspace_doc': 'doc',
    'onb.type.code_change': 'change',
    'onb.type.note': 'note',
    // Relative time
    'onb.time.just_now': 'just now',
    'onb.time.minutes_ago': '{n}m ago',
    'onb.time.hours_ago': '{n}h ago',
    'onb.time.yesterday': 'yesterday',
    'onb.time.days_ago': '{n}d ago',
    'onb.time.months_ago': '{n}mo ago',
    'onb.time.long_ago': 'long ago',
    'onb.result.untitled': '(untitled)',
    'onb.recall.stats': '⚡ {ms} ms · {hits} memories · from your {total} total',

    // Step 4 Wiki (Aha)
    'onb.wiki.title': 'Awareness generated these Wiki pages',
    'onb.wiki.description': 'Auto-built from your codebase. Your AI can reference these anytime.',
    'onb.wiki.view_all': 'View all {n} pages →',
    'onb.wiki.next': 'Pretty cool! Next',
    'onb.wiki.empty': 'No wiki pages yet. Add docs and re-scan to see them.',

    // Step 5 Cloud
    'onb.cloud.title': 'Want to unlock more?',
    'onb.cloud.intro': 'Everything you saw works offline. Cloud adds:',
    'onb.cloud.feat_sync.title': 'Sync across devices',
    'onb.cloud.feat_sync.desc': 'Your memory on laptop + desktop + multiple projects',
    'onb.cloud.feat_team.title': 'Team memory sharing',
    'onb.cloud.feat_team.desc': 'Invite members to share memory (already supported)',
    'onb.cloud.feat_growth.title': 'Growth analytics',
    'onb.cloud.feat_growth.desc': 'See what your AI actually learned',
    'onb.cloud.feat_market.title': 'Memory marketplace',
    'onb.cloud.feat_market.desc': 'Install expert knowledge packs',
    'onb.cloud.free_tier': 'Free tier: 1,000 memories · 5 projects · no credit card',
    'onb.cloud.cta_connect': 'Connect cloud',
    'onb.cloud.cta_later': 'Maybe later',
    'onb.cloud.hint_settings': 'You can connect anytime from Settings → Cloud',
    // device-auth states
    'onb.auth.title': 'Connect via device authorization',
    'onb.auth.body': 'We opened the authorization page in your browser. If it did not open, visit:',
    'onb.auth.code_label': 'Enter this code:',
    'onb.auth.pending': 'Waiting for authorization… (no account? the page will prompt you to sign up)',
    'onb.auth.cancel': 'Cancel',
    'onb.auth.reopen': 'Reopen browser',
    'onb.auth.select_title': 'Pick a memory to sync to this device',
    'onb.auth.confirm': 'Confirm and connect',
    'onb.auth.failed': 'Authorization failed. Please retry.',

    // Step 6 Done
    'onb.done.title': "You're all set!",
    'onb.done.checked_index': 'Project indexed',
    'onb.done.checked_wiki': 'Wiki generated',
    'onb.done.checked_mcp': 'MCP endpoint ready',
    'onb.done.checked_cloud': 'Cloud sync enabled',
    'onb.done.next_title': "What's next:",
    'onb.done.next_connect': 'Connect to your AI tool',
    'onb.done.next_quickstart': 'Read the quickstart guide',
    'onb.done.next_community': 'Join the community for tips',
    'onb.done.cta': 'Open Dashboard',

    // Common
    'onb.step_of': 'Step {n} of {total}',
    'onb.optional': 'OPTIONAL',
    'onb.skip_step': 'Skip step',
    'onb.skip_finish': 'Skip, finish',
    'onb.back': 'Back',
    'onb.next': 'Next',
  };

  const ZH = {
    // Status chip (persistent widget)
    'onb.chip.local_mode': '本地模式',
    'onb.chip.cloud_on': '云端已同步',
    'onb.chip.connect_cta': '连接云端 →',

    // Privacy settings (Settings → Privacy)
    'privacy.title': '📊 使用情况统计',
    'privacy.toggle_label': '发送匿名使用数据',
    'privacy.toggle_desc': '帮助我们优先开发功能。需主动开启。不收集记忆内容、文件路径、查询内容或 IP 地址。',
    'privacy.enabled': '已启用',
    'privacy.disabled': '已关闭',
    'privacy.install_id': '安装 ID',
    'privacy.view_recent': '查看最近的事件',
    'privacy.delete_data': '删除我的数据',
    'privacy.confirm_delete': '删除该安装的所有遥测数据？将清空本地队列并请求云端删除。',
    'privacy.deleted_msg': '本地队列已清空，云端删除请求已发送。',

    // Step 1 Welcome
    'onb.welcome.title': '欢迎使用 Awareness',
    'onb.welcome.subtitle': '为你的 AI Agent 提供持久记忆层',
    'onb.welcome.bullet_index': '扫描你当前的项目',
    'onb.welcome.bullet_recall': '体验 recall 的召回效果',
    'onb.welcome.bullet_connect': '连接 Claude Code / OpenClaw',
    'onb.welcome.bullet_cloud': '（可选）开启云端同步',
    'onb.welcome.cta': '开始使用',
    'onb.welcome.skip_all': '跳过，自己探索',
    'onb.welcome.telemetry_label': '匿名使用统计',
    'onb.welcome.telemetry_hint': '默认开启，帮助我们改进产品。我们绝不收集记忆内容、文件路径、查询内容或 IP 地址。可随时在 设置 → 隐私 中关闭。',

    // Step 2 Scan
    'onb.scan.title': '来扫描你的第一个项目',
    'onb.scan.current_dir': '当前目录',
    'onb.scan.intro': '将扫描代码文件（40+ 语言）、Markdown 文档，并构建符号图谱 + Wiki。',
    'onb.scan.privacy': '全程在本地运行，任何数据不会离开你的设备。',
    'onb.scan.cta': '开始扫描',
    'onb.scan.progress': '扫描中… {pct}%',
    'onb.scan.summary': '找到 {files} 文件 · {symbols} 符号 · {wiki} 个 Wiki 页面',

    // Step 3 First Recall
    'onb.recall.title': '来试试问你的记忆',
    'onb.recall.hint': '点击下面的建议问题（基于你刚扫描的项目）：',
    'onb.recall.input_ph': '问点什么…',
    'onb.recall.results': '结果',
    'onb.recall.no_results': '暂无匹配 — 先添加一些记忆再试',
    'onb.recall.next': '下一步：看 Wiki',
    'onb.q.readme': '总结一下 README',
    'onb.q.architecture': '这个项目的架构是什么？',
    'onb.q.wiki_page': '介绍一下 {title}',
    'onb.q.lang': '项目里有哪些 {lang} 文件？',
    'onb.q.decisions': '这里做过什么决策？',
    'onb.q.tag': '介绍一下 {tag}',
    'onb.q.recent_decision': '最近做过哪些决策？',
    'onb.q.recent_pitfall': '最近踩过哪些坑？',
    'onb.type.decision': '决策',
    'onb.type.problem_solution': '解决方案',
    'onb.type.pitfall': '坑',
    'onb.type.insight': '洞察',
    'onb.type.workflow': '流程',
    'onb.type.key_point': '要点',
    'onb.type.workspace_file': '文件',
    'onb.type.workspace_wiki': 'Wiki',
    'onb.type.workspace_doc': '文档',
    'onb.type.code_change': '代码变更',
    'onb.type.note': '笔记',
    'onb.time.just_now': '刚刚',
    'onb.time.minutes_ago': '{n} 分钟前',
    'onb.time.hours_ago': '{n} 小时前',
    'onb.time.yesterday': '昨天',
    'onb.time.days_ago': '{n} 天前',
    'onb.time.months_ago': '{n} 个月前',
    'onb.time.long_ago': '很久以前',
    'onb.result.untitled': '（无标题）',
    'onb.recall.stats': '⚡ {ms} 毫秒 · 找到 {hits} 条 · 来自你 {total} 条记忆',

    // Step 4 Wiki
    'onb.wiki.title': 'Awareness 为你生成了这些 Wiki 页面',
    'onb.wiki.description': '基于你的代码库自动生成。你的 AI 随时可以引用。',
    'onb.wiki.view_all': '查看全部 {n} 页 →',
    'onb.wiki.next': '很不错！下一步',
    'onb.wiki.empty': '暂无 Wiki 页面。添加文档后重新扫描即可看到。',

    // Step 5 Cloud
    'onb.cloud.title': '要解锁更多能力吗？',
    'onb.cloud.intro': '你看到的一切都能离线工作。连接云端可以：',
    'onb.cloud.feat_sync.title': '跨设备同步',
    'onb.cloud.feat_sync.desc': '笔记本 + 台式机 + 多项目统一记忆',
    'onb.cloud.feat_team.title': '团队记忆分享',
    'onb.cloud.feat_team.desc': '邀请成员共享 memory（已支持）',
    'onb.cloud.feat_growth.title': '成长分析',
    'onb.cloud.feat_growth.desc': '看 AI 真正学到了什么',
    'onb.cloud.feat_market.title': '记忆商城',
    'onb.cloud.feat_market.desc': '安装领域专家知识包',
    'onb.cloud.free_tier': '免费额度：1,000 条记忆 · 5 个项目 · 无需信用卡',
    'onb.cloud.cta_connect': '连接云端',
    'onb.cloud.cta_later': '稍后再说',
    'onb.cloud.hint_settings': '可随时在「设置 → 云端」连接',
    'onb.auth.title': '通过设备授权连接',
    'onb.auth.body': '已为你在浏览器打开授权页。如果没自动打开，请访问：',
    'onb.auth.code_label': '输入验证码：',
    'onb.auth.pending': '等待授权中…（还没账号？页面会引导你注册）',
    'onb.auth.cancel': '取消',
    'onb.auth.reopen': '重新打开浏览器',
    'onb.auth.select_title': '选择要同步到这台设备的 memory',
    'onb.auth.confirm': '确认连接',
    'onb.auth.failed': '授权失败，请重试。',

    // Step 6 Done
    'onb.done.title': '全部完成！',
    'onb.done.checked_index': '项目已建立索引',
    'onb.done.checked_wiki': 'Wiki 已生成',
    'onb.done.checked_mcp': 'MCP 端点已就绪',
    'onb.done.checked_cloud': '云端同步已开启',
    'onb.done.next_title': '接下来：',
    'onb.done.next_connect': '连接你的 AI 工具',
    'onb.done.next_quickstart': '阅读快速入门',
    'onb.done.next_community': '加入社区交流',
    'onb.done.cta': '进入 Dashboard',

    // Common
    'onb.step_of': '第 {n} 步 / 共 {total} 步',
    'onb.optional': '可选',
    'onb.skip_step': '跳过此步',
    'onb.skip_finish': '跳过，完成',
    'onb.back': '上一步',
    'onb.next': '下一步',
  };

  Object.assign(window.LOCALES.en, EN);
  Object.assign(window.LOCALES.zh, ZH);
})();
