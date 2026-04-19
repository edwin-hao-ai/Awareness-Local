/**
 * F-056 · extraction eval corpus — card accuracy across categories,
 * languages, and content styles.
 *
 * Coverage matrix:
 *   - 15 card categories (6 technical + 7 personal + skill side-channel + noise)
 *   - 3 languages (English / 中文 / 日本語)
 *   - 3 content styles (dev / user preference / general memory)
 *
 * Each entry is an `awareness_record` payload + the properties a
 * well-behaved extraction must satisfy. Used by the static offline
 * eval (`f056-extraction-eval-offline.test.mjs`) and the opt-in
 * live-LLM eval (`scripts/eval-extraction.mjs --live`).
 *
 * If you change what a category means in the shared prompts, add /
 * modify a case here too so the evaluation stays honest.
 */

export const EVAL_CASES = [
  // =====================================================================
  // TECH · decision (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'decision-pgvector',
    lang: 'en',
    style: 'dev',
    category_under_test: 'decision',
    content:
      'We decided to switch from Pinecone to pgvector for vector storage. ' +
      'Main driver is cost (saves ~$70/month) and co-location with relational ' +
      'data. Trade-off accepted: lower QPS past ~10M vectors, OK at our scale. ' +
      'Setup involved `CREATE EXTENSION vector`, a new `memory_vectors` table, ' +
      'cosine distance via the `<=>` operator.',
    expect: {
      MUST_EMIT: [{
        category: 'decision',
        title_contains: /pgvector/i,
        summary_contains: [/pinecone/i, /trade.?off/i, /cost|\$70/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'decision-jwt-over-session-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'decision',
    content:
      '决定：采用 JWT（HS256）替代 session-based 认证。原因：前端是 Next.js SSR + 移动 App ' +
      '混合部署，session cookie 在跨域场景下运维复杂；JWT 无状态便于水平扩展。取舍：无法单点 ' +
      '强制失效，通过短 exp（15 分钟）+ refresh token 弥补。实现文件：`backend/auth/jwt.py`。',
    expect: {
      MUST_EMIT: [{
        category: 'decision',
        title_contains: /JWT|认证|auth/i,
        summary_contains: [/JWT|session|exp|refresh/i, /取舍|trade|无法/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'decision-use-bun-ja',
    lang: 'ja',
    style: 'dev',
    category_under_test: 'decision',
    content:
      '決定: Node.js から Bun に切り替える。理由: npm install が 3 倍速く、テスト実行も約 2 ' +
      '倍速い。監視ツール Vercel Analytics は Bun でも動作確認済み。トレードオフ: 一部のネイ' +
      'ティブモジュール (`better-sqlite3`) が Bun で不安定なため、デーモンは Node のまま。',
    expect: {
      MUST_EMIT: [{
        category: 'decision',
        title_contains: /Bun|Node/i,
        summary_contains: [/Bun|トレードオフ|理由|better-sqlite3/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // TECH · problem_solution (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'problem-solution-request-prefix',
    lang: 'en',
    style: 'dev',
    category_under_test: 'problem_solution',
    content:
      'Bug: memory card titles all start with "Request: ..." because the ' +
      'daemon `_remember` was calling `classifyNoiseEvent` but not ' +
      '`cleanContent` before deriving the title. Fix: call ' +
      '`cleanContent(params.content)` in sdks/local/src/daemon.mjs:802 ' +
      'before the auto-title derivation. Regression guard: ' +
      '`remember-envelope-strip.test.mjs`.',
    expect: {
      MUST_EMIT: [{
        category: 'problem_solution',
        title_contains: /request.*prefix|envelope|clean[_\s]?content|title/i,
        summary_contains: [/daemon\.mjs|cleanContent/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'problem-solution-cjk-path-header-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'problem_solution',
    content:
      '现象：Windows 用户（用户名是中文「张三」）和 macOS 用户（工作区叫「项目 🚀」）报错 ' +
      '`记忆保存失败：Invalid character in header content ["X-Awareness-Project-Dir"]`。' +
      '根因：Node 的 http.request() 拒绝非 ISO-8859-1 字节进 HTTP header。修复：memory-client ' +
      '用 base64 编码 CJK/emoji 路径，daemon 端 decode。文件：sdks/local/src/daemon/helpers.mjs。',
    expect: {
      MUST_EMIT: [{
        category: 'problem_solution',
        title_contains: /CJK|中文|路径|header|invalid character/i,
        summary_contains: [/base64|ISO-8859-1|http\.request/i, /memory-client|daemon/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'problem-solution-tls-cert-expired-ja',
    lang: 'ja',
    style: 'dev',
    category_under_test: 'problem_solution',
    content:
      '障害: 本番環境で `TLS certificate expired` エラーで全 API が 503。原因: Let\'s Encrypt ' +
      'の自動更新 cron が 30 日前に停止していた (systemd timer の enabled=false)。修正: ' +
      '`systemctl enable certbot-renew.timer` + 即時 `certbot renew --force`。再発防止: ' +
      '証明書有効期限を Prometheus の `ssl_cert_not_after` メトリクスで監視。',
    expect: {
      MUST_EMIT: [{
        category: 'problem_solution',
        title_contains: /TLS|certificate|certbot|証明書/i,
        summary_contains: [/certbot|systemctl|Let.?s Encrypt|Prometheus/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // TECH · workflow (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'workflow-publish-npm',
    lang: 'en',
    style: 'dev',
    category_under_test: 'workflow',
    content:
      'To publish @awareness-sdk/* packages to npm: (1) bump ' +
      '`package.json` version + update CHANGELOG.md with user-visible ' +
      'changes, (2) run `npm publish --access public --registry=' +
      'https://registry.npmjs.org/` (do NOT omit --registry, China ' +
      'mirror rejects publish), (3) verify with `npm view <pkg> version`.',
    expect: {
      MUST_EMIT: [{
        category: 'workflow',
        title_contains: /publish|npm/i,
        summary_contains: [/--registry/i, /access public|--access/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'workflow-db-migration-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'workflow',
    content:
      '数据库迁移流程（生产）：1) 本地跑 `DOCKER_VOLUME_DIRECTORY=. docker compose up -d ' +
      'postgres` 先验证迁移 SQL；2) `docker exec awareness-backend python -m prisma migrate ' +
      'deploy`；3) 本地 ok 才 push；4) 生产 `ssh server && cd /opt/awareness && docker compose ' +
      '-f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d backend mcp ' +
      'worker beat`；**绝不重建 postgres 容器**（scram-sha-256 auth 会失效）。',
    expect: {
      MUST_EMIT: [{
        category: 'workflow',
        title_contains: /迁移|migration|数据库|prisma|deploy/i,
        summary_contains: [/prisma|postgres|docker compose/i, /不重建|scram|auth/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // TECH · pitfall (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'pitfall-bot-worker-kill',
    lang: 'en',
    style: 'dev',
    category_under_test: 'pitfall',
    content:
      'Pitfall: `openclaw channels login` is a long-running bot worker, ' +
      'not a one-shot command. It never exits after QR scan — kill-on-' +
      'timeout logic must distinguish "command" vs "worker" or it will ' +
      'terminate live WeChat/WhatsApp sessions. Avoidance: maintain PID ' +
      'safelist; never kill processes in the `activeLogins` Map.',
    expect: {
      MUST_EMIT: [{
        category: 'pitfall',
        title_contains: /bot worker|channels login|long.?running/i,
        summary_contains: [/pid|kill|avoidance|safelist/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'pitfall-npm-mirror-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'pitfall',
    content:
      '坑：本机 npm registry 默认是中国镜像 `https://registry.npmmirror.com`，镜像**只接受 ' +
      'install，不接受 publish**。不显式加 `--registry=https://registry.npmjs.org/` 发布会报 ' +
      '`ENEEDAUTH need auth`。规避：所有 publish 命令必须显式加 --registry 和 --access public。',
    expect: {
      MUST_EMIT: [{
        category: 'pitfall',
        title_contains: /npm|mirror|registry|镜像/i,
        summary_contains: [/npmmirror|--registry|ENEEDAUTH|publish/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'pitfall-async-leak-ja',
    lang: 'ja',
    style: 'dev',
    category_under_test: 'pitfall',
    content:
      '落とし穴: Python の asyncio で `asyncio.create_task(...)` の返り値を保持しないと、' +
      'ガベージコレクタに途中で回収されてタスクが消える。影響: 非同期のログ書き込みが 30% ' +
      '程度欠落。回避: `background_tasks.add(task)` のように強参照を保つか、`asyncio.gather` ' +
      'で待つ。参考: Python 3.12 公式ドキュメント「Event Loop」。',
    expect: {
      MUST_EMIT: [{
        category: 'pitfall',
        title_contains: /asyncio|task|gc|ガベージ|create_task/i,
        summary_contains: [/create_task|gather|参照|background/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // TECH · insight (EN / 中文)
  // =====================================================================

  {
    id: 'insight-long-running-vs-oneshot',
    lang: 'en',
    style: 'dev',
    category_under_test: 'insight',
    content:
      'Pattern surfaced after debugging the bot-worker kill bug: any agent-' +
      'framework plugin wrapping a CLI that spawns workers needs two ' +
      'distinct cleanup strategies — one for short commands (kill on ' +
      'idle-timeout) and one for long-running workers (only kill via ' +
      'explicit disconnect). Same heuristic cannot apply to both.',
    expect: {
      MUST_EMIT: [{
        category: 'insight',
        title_contains: /pattern|worker|cleanup|long.?running/i,
        summary_contains: [/strateg|cleanup|worker|cli/i],
        summary_min_chars: 80,
      }],
    },
  },

  {
    id: 'insight-separation-of-record-vs-recall-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'insight',
    content:
      '发现的一个规律：记忆系统的召回质量上限由 record 时卡片的质量决定。即使 recall 算法再优' +
      '，如果 record 时 summary 是一句话、没有 tag、没有 score，embedding 空间就只有稀疏信号' +
      '。这意味着 **prompt 设计决定了整个记忆系统的天花板**，不是后期优化能补的。适用于所有 ' +
      '「agent + 记忆」架构。反例：如果 record 已经用 wiki 级 summary + 完整 tag + 评分，' +
      '即使是简单 BM25 也能达到 80% precision@3。',
    expect: {
      MUST_EMIT: [{
        category: 'insight',
        title_contains: /record|召回|recall|prompt|质量/i,
        summary_contains: [/prompt|embedding|record|tag|score/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // TECH · key_point (EN)
  // =====================================================================

  {
    id: 'key-point-openclaw-channels-enum',
    lang: 'en',
    style: 'dev',
    category_under_test: 'key_point',
    content:
      'Key fact: `openclaw channels add --channel` only accepts a fixed ' +
      'enum: `telegram|whatsapp|discord|irc|googlechat|slack|signal|' +
      'imessage|line`. Matrix and Nostr are NOT in the enum — configure ' +
      'those by directly writing `openclaw.json`. Parse the enum at ' +
      'runtime from `openclaw channels add --help` to decide which path.',
    expect: {
      MUST_EMIT: [{
        category: 'key_point',
        title_contains: /channel|enum|openclaw/i,
        summary_contains: [/telegram|enum|openclaw\.json/i],
        summary_min_chars: 80,
      }],
    },
  },

  // =====================================================================
  // PERSONAL · personal_preference (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'personal-preference-dark-mode',
    lang: 'en',
    style: 'preference',
    category_under_test: 'personal_preference',
    content:
      'User prefers dark mode across all IDEs and terminals — specifically ' +
      'the solarized-dark theme. Applies to every project they work on.',
    expect: {
      MUST_EMIT: [{
        category: 'personal_preference',
        title_contains: /dark.?mode|solarized|theme/i,
        summary_contains: [/dark|solarized/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'personal-preference-chinese-first-zh',
    lang: 'zh',
    style: 'preference',
    category_under_test: 'personal_preference',
    content:
      '用户偏好：所有推理和回复都用中文，代码用英文。这是一个长期偏好，适用于所有项目。',
    expect: {
      MUST_EMIT: [{
        category: 'personal_preference',
        title_contains: /中文|language|bilingual|代码/i,
        summary_contains: [/中文|代码|英文/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'personal-preference-minimal-ui-ja',
    lang: 'ja',
    style: 'preference',
    category_under_test: 'personal_preference',
    content:
      'ユーザーの好み: UI はミニマル志向で、余計なボタンやアイコンを嫌う。macOS のように余' +
      '白を重視したデザインを好む。Windows の密集型 UI は避ける。',
    expect: {
      MUST_EMIT: [{
        category: 'personal_preference',
        title_contains: /UI|ミニマル|好み|minimal/i,
        summary_contains: [/ミニマル|余白|macOS|Windows/i],
        summary_min_chars: 40,
      }],
    },
  },

  // =====================================================================
  // PERSONAL · activity_preference (EN / 中文 / 日本語)
  // =====================================================================

  {
    id: 'activity-preference-weekend-cooking',
    lang: 'en',
    style: 'preference',
    category_under_test: 'activity_preference',
    content:
      'User typically cooks on weekends — likes making clear-broth beef ' +
      'noodle soup (清汤牛肉面). Mentions this as a recurring weekend ' +
      'activity, not a one-off.',
    expect: {
      MUST_EMIT: [{
        category: 'activity_preference',
        title_contains: /cook|weekend|noodle|牛肉面/i,
        summary_contains: [/weekend|cook|noodle|牛肉面/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'activity-preference-morning-run-zh',
    lang: 'zh',
    style: 'preference',
    category_under_test: 'activity_preference',
    content:
      '习惯：每天早上 6 点跑步 30 分钟，7 年多从未间断。下雨天改在室内跑步机。周末会拉长到 ' +
      '10 公里。',
    expect: {
      MUST_EMIT: [{
        category: 'activity_preference',
        title_contains: /跑步|晨跑|运动|morning run/i,
        summary_contains: [/跑步|公里|分钟|7 年|习惯/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'activity-preference-onsen-ja',
    lang: 'ja',
    style: 'preference',
    category_under_test: 'activity_preference',
    content:
      '趣味: 月に 1 回は温泉に行く。特に草津、箱根、有馬が好み。仕事が立て込んでストレスが溜' +
      'まった時の定番リフレッシュ方法。',
    expect: {
      MUST_EMIT: [{
        category: 'activity_preference',
        title_contains: /温泉|趣味|onsen/i,
        summary_contains: [/温泉|草津|箱根|有馬|ストレス/i],
        summary_min_chars: 40,
      }],
    },
  },

  // =====================================================================
  // PERSONAL · important_detail (EN / 中文)
  // =====================================================================

  {
    id: 'important-detail-team-size',
    lang: 'en',
    style: 'general',
    category_under_test: 'important_detail',
    content:
      'Important fact about the project: the Awareness Memory team is 2 ' +
      'engineers full-time (Edwin + one agent contributor) plus part-time ' +
      'LLM agent contributors. Main account email is everest9812@gmail.com, ' +
      'GitHub org is edwin-hao-ai.',
    expect: {
      MUST_EMIT: [{
        category: 'important_detail',
        title_contains: /team|project|account/i,
        summary_contains: [/team|engineer|edwin/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'important-detail-company-zh',
    lang: 'zh',
    style: 'general',
    category_under_test: 'important_detail',
    content:
      '公司信息：「Awareness Memory」注册主体为北京 VGO 有限公司，Apple Developer Team ID 是 ' +
      '5XNDF727Y6。主域名 awareness.market，官网服务器 IP 66.42.50.14（Vultr 东京节点）。',
    expect: {
      MUST_EMIT: [{
        category: 'important_detail',
        title_contains: /公司|VGO|Apple|company|team ID/i,
        summary_contains: [/VGO|5XNDF727Y6|awareness\.market|Vultr/i],
        summary_min_chars: 40,
      }],
    },
  },

  // =====================================================================
  // PERSONAL · plan_intention (EN / 中文)
  // =====================================================================

  {
    id: 'plan-intention-q2-public-launch',
    lang: 'en',
    style: 'general',
    category_under_test: 'plan_intention',
    content:
      'Plan: user intends to open-source AwarenessClaw publicly in Q2 2026, ' +
      'with a landing page at awareness.market and automated DMG/exe/AppImage ' +
      'builds through GitHub Releases. Target: 500 GitHub stars in 90 days post-launch.',
    expect: {
      MUST_EMIT: [{
        category: 'plan_intention',
        title_contains: /plan|launch|open.?source|q2/i,
        summary_contains: [/q2|launch|github|dmg/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'plan-intention-yc-apply-zh',
    lang: 'zh',
    style: 'general',
    category_under_test: 'plan_intention',
    content:
      '计划：2026 Q3 申请 YC W27 批次。准备材料：demo video (60s)、founder video (90s)、产品 ' +
      'metrics (DAU / retention / revenue)、traction 叙述。截止日期 2026-09-30。',
    expect: {
      MUST_EMIT: [{
        category: 'plan_intention',
        title_contains: /YC|W27|计划|申请/i,
        summary_contains: [/YC|W27|demo|metrics|2026/i],
        summary_min_chars: 40,
      }],
    },
  },

  // =====================================================================
  // PERSONAL · health_info / career_info / custom_misc
  // =====================================================================

  {
    id: 'health-info-ergonomic-break',
    lang: 'en',
    style: 'general',
    category_under_test: 'health_info',
    content:
      'User has chronic neck strain — takes a 10-minute break every hour ' +
      'while coding, enforced via a Pomodoro timer. Long-term health rule.',
    expect: {
      MUST_EMIT: [{
        category: 'health_info',
        title_contains: /neck|break|pomodoro|health|ergonom/i,
        summary_contains: [/break|neck|pomodoro/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'career-info-founder-role',
    lang: 'en',
    style: 'general',
    category_under_test: 'career_info',
    content:
      'User is founder and lead engineer of Awareness Memory, a solo-startup ' +
      'project. Background: 10 years backend engineering, now pivoting to AI ' +
      'infrastructure. Prior role: staff engineer at a large SaaS company ' +
      '(stepped down 2026-01).',
    expect: {
      MUST_EMIT: [{
        category: 'career_info',
        title_contains: /founder|engineer|career|background/i,
        summary_contains: [/founder|engineer|background/i],
        summary_min_chars: 40,
      }],
    },
  },

  {
    id: 'custom-misc-favorite-color-zh',
    lang: 'zh',
    style: 'preference',
    category_under_test: 'custom_misc',
    content:
      '用户最喜欢的颜色是灰蓝色 (#4a7882)。在选 Awareness Memory 官网品牌色时提到过。',
    expect: {
      MUST_EMIT: [{
        category: 'custom_misc',
        title_contains: /颜色|品牌|color|brand/i,
        summary_contains: [/灰蓝|4a7882|品牌/i],
        summary_min_chars: 40,
      }],
    },
  },

  // =====================================================================
  // SKILL (skills[] side-channel)
  // =====================================================================

  {
    id: 'skill-rebuild-goldens',
    lang: 'en',
    style: 'dev',
    category_under_test: 'skill',
    content:
      'Process we use every time the daemon schema changes: (1) run ' +
      '`node scripts/rebuild-goldens.mjs --snapshot` to refresh golden ' +
      'snapshots in sdks/local/test/goldens, (2) verify with ' +
      '`npm test -- --test-name-pattern golden`, (3) commit the updated ' +
      'snapshots in the same PR as the schema change. Trigger: "when ' +
      'changing MCP response shape or daemon handler return values".',
    expect: {
      MUST_EMIT_SKILL: {
        name_contains: /golden|snapshot/i,
        methods_min: 3,
        trigger_patterns_min: 1,
      },
    },
  },

  {
    id: 'skill-release-sdk-zh',
    lang: 'zh',
    style: 'dev',
    category_under_test: 'skill',
    content:
      '每次发 @awareness-sdk/* 包到 npm 的流程：(1) bump `sdks/<pkg>/package.json` 的 version，' +
      '同步更新 CHANGELOG.md；(2) `npm publish --access public --registry=https://registry.' +
      'npmjs.org/ --//registry.npmjs.org/:_authToken=$NPM_TOKEN`；(3) 用 `npm view <pkg> ' +
      'version` 验证新版已上；(4) git push 触发 CI 同步到 Awareness-SDK 公开仓库。触发条件：' +
      '"SDK 需要发版"、"awareness-sdk 版本 bump"。',
    expect: {
      MUST_EMIT_SKILL: {
        name_contains: /publish|release|SDK|npm/i,
        methods_min: 3,
        trigger_patterns_min: 1,
      },
    },
  },

  // =====================================================================
  // NOISE (EN / 中文 / 日本語) — must emit nothing
  // =====================================================================

  {
    id: 'noise-greeting',
    lang: 'en',
    style: 'noise',
    category_under_test: 'none',
    content: 'hi',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-greeting-zh',
    lang: 'zh',
    style: 'noise',
    category_under_test: 'none',
    content: '你好啊',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-greeting-ja',
    lang: 'ja',
    style: 'noise',
    category_under_test: 'none',
    content: 'こんにちは',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-envelope-only',
    lang: 'en',
    style: 'noise',
    category_under_test: 'none',
    content:
      'Sender (untrusted metadata): openclaw-runtime\n\n' +
      '[Subagent Context]\n' +
      'system handoff',
    expect: { MUST_EMIT: [], DAEMON_SHOULD_REJECT: true },
  },

  {
    id: 'noise-status',
    lang: 'en',
    style: 'noise',
    category_under_test: 'none',
    content: 'building… retrying… ✅ done',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-tool-test',
    lang: 'en',
    style: 'noise',
    category_under_test: 'none',
    content: 'let me test if awareness_recall works. (testing the tool itself, no real bug)',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-command-zh',
    lang: 'zh',
    style: 'noise',
    category_under_test: 'none',
    content: '跑一下测试',
    expect: { MUST_EMIT: [] },
  },

  {
    id: 'noise-command-ja',
    lang: 'ja',
    style: 'noise',
    category_under_test: 'none',
    content: 'テストを実行してください',
    expect: { MUST_EMIT: [] },
  },
];

/** Group helper — per-category coverage accounting. */
export const COVERED_CATEGORIES = [
  ...new Set(EVAL_CASES.map((c) => c.category_under_test).filter((c) => c && c !== 'none')),
];

/** Group helper — language coverage. */
export const COVERED_LANGUAGES = [
  ...new Set(EVAL_CASES.map((c) => c.lang).filter(Boolean)),
];
