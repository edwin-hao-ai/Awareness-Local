/**
 * Content-quality + token-saving scorecard for the AwarenessClaw envelope-strip
 * fix in daemon._remember (2026-04-18).
 *
 * Simulates a realistic batch of AwarenessClaw turn_briefs
 * (Request:/Result: envelope), each long enough to pass the short_noise
 * filter so we actually exercise the envelope-strip path.
 *
 * Measures:
 *   - title clean rate:    % of auto-generated titles NOT starting with "Request:"
 *   - content clean rate:  % of persisted content NOT starting with "Request:"
 *   - body preservation:   % of turns where the user's actual message survived
 *   - token savings:       bytes saved by stripping envelope prefixes
 *
 * Composite 0-10, threshold 8.5. Short-noise-filtered turns are excluded
 * from quality percentages (they're legit skips), but counted as token savings.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';


const SIMULATED_BATCH = [
  {
    content: 'Request: 我们决定用 pgvector 替代 Pinecone，原因是可以与关系数据共存，省掉每月 70 美元，而且 IVFFlat + HNSW 索引对我们 <5M 向量规模足够了。\nResult: 好的，我会把这个决策记录到知识库里，并提醒下次搜索时优先使用 hybrid search。',
    expect_body_token: 'pgvector|Pinecone',
  },
  {
    content: 'Request: 修复一个奇怪 bug：JWT 24h 过期但用户 5 分钟就被踢出，根因是 OAuth refresh callback 和页面加载 restore 在同时写 localStorage.jwt，没有锁。\nResult: 建议用 AuthStore.setToken() 加 mutex，OAuth 侧先对比 issued_at 再覆盖。',
    expect_body_token: 'JWT|OAuth|mutex',
  },
  {
    content: 'Request: 怎么规划五一去云南的行程？五天四夜，想去昆明大理丽江。\nResult: 推荐：Day1 昆明滇池，Day2 飞大理洱海，Day3 喜洲古镇+三塔，Day4 丽江古城+玉龙雪山，Day5 返回昆明。',
    expect_body_token: '云南|大理|丽江',
  },
  {
    content: 'Request: 我想学日语但坚持不下来，有什么方法吗？\nResult: 推荐间隔重复法 + 每天 20 个单词，同时配合动漫看真实对话场景。每周复习一次旧单词，三个月能看懂日常日语。',
    expect_body_token: '日语|间隔重复',
  },
  {
    content: 'Request: 最近总是失眠，压力大，怎么办？\nResult: 建议睡前 2 小时远离屏幕，试试 4-7-8 呼吸法。日间运动 30 分钟能显著改善睡眠。如果持续超过 2 周建议看医生。',
    expect_body_token: '失眠|呼吸',
  },
  {
    content: 'Request: 写个 Python 函数检查邮箱格式，要支持国际域名\nResult: 推荐用 email-validator 库：from email_validator import validate_email; 它比 re.match 更准，支持 punycode 和 IDN。',
    expect_body_token: 'Python|email',
  },
  {
    content: 'Request: 我最喜欢喝咖啡了，特别是手冲，夏天冰滴也不错。请记下来我的口味偏好。\nResult: 已记录：手冲 > 其他；夏天冰滴。下次推荐咖啡店或配方会优先考虑这两类。',
    expect_body_token: '咖啡|手冲',
  },
  {
    content: 'Request: 分享下我最近的健身计划：周一周三周五力量，周二周四跑步 5 公里，周末休息或爬山。\nResult: 好的，这个安排强度适中有氧和无氧结合。建议下周加一次 yoga 放松，能提升恢复质量。',
    expect_body_token: '健身|跑步',
  },
];


function tokEst(s) { return Math.max(1, Math.floor(s.length / 3)); }


describe('Scorecard — AwarenessClaw envelope strip on realistic batch', () => {
  it('composite score >= 8.5 / 10', async () => {
    const mod = await import('../src/daemon.mjs');
    const stored = [];
    const results = [];
    const fake = Object.create(mod.AwarenessLocalDaemon.prototype);
    fake.memoryStore = {
      write: async (m) => {
        stored.push(m);
        return { id: `m${stored.length}`, filepath: '/tmp/x.md' };
      },
    };
    fake.indexer = { indexMemory: () => {} };
    fake._embedAndStore = async () => {};
    fake._extractAndIndex = () => {};
    fake.cloudSync = { isEnabled: () => false };

    for (const turn of SIMULATED_BATCH) {
      const r = await fake._remember({
        content: turn.content,
        event_type: 'turn_brief',
        source: 'desktop',
        agent_role: 'builder_agent',
      });
      results.push({ turn, result: r });
    }

    const n = stored.length;
    const skipped = results.filter(r => r.result.status === 'skipped').length;

    // Quality — only measured on items that actually got stored
    const clean_titles = stored.filter(s => !/^Request:/i.test(s.title) && !/^Result:/i.test(s.title));
    const clean_contents = stored.filter(s => !/^Request:/i.test(s.content) && !/^Result:/i.test(s.content));
    const body_preserved = stored.filter((s, i) => {
      // Find the original turn that produced this stored item
      const original = results.filter(r => r.result.status === 'ok')[i]?.turn;
      if (!original) return false;
      return new RegExp(original.expect_body_token, 'i').test(s.content);
    });

    const total_raw_tokens = SIMULATED_BATCH.reduce((sum, t) => sum + tokEst(t.content), 0);
    const total_stored_tokens = stored.reduce((sum, s) => sum + tokEst(s.content), 0);
    const tokens_saved = total_raw_tokens - total_stored_tokens;
    const savings_pct = tokens_saved / Math.max(total_raw_tokens, 1) * 100;

    const title_rate = n > 0 ? clean_titles.length / n : 1;
    const content_rate = n > 0 ? clean_contents.length / n : 1;
    const body_rate = n > 0 ? body_preserved.length / n : 1;

    const composite = +(
      title_rate * 3 +
      content_rate * 3 +
      body_rate * 3 +
      Math.min(savings_pct / 15, 1) * 1
    ).toFixed(2);

    console.log();
    console.log('=' .repeat(66));
    console.log('AwarenessClaw envelope-strip · Content Quality + Token-Saving');
    console.log('=' .repeat(66));
    console.log(`Batch size:          ${SIMULATED_BATCH.length} AwarenessClaw turn_briefs`);
    console.log(`Stored:              ${n}   (${skipped} skipped by short_noise / other gates)`);
    console.log();
    console.log('── Content quality (on stored items) ──');
    console.log(`  Clean titles:      ${clean_titles.length}/${n} = ${(title_rate * 100).toFixed(0)}%`);
    console.log(`  Clean contents:    ${clean_contents.length}/${n} = ${(content_rate * 100).toFixed(0)}%`);
    console.log(`  Body preserved:    ${body_preserved.length}/${n} = ${(body_rate * 100).toFixed(0)}%`);
    console.log();
    console.log('── Token savings ──');
    console.log(`  Raw:               ${total_raw_tokens} tokens`);
    console.log(`  Stored:            ${total_stored_tokens} tokens`);
    console.log(`  Saved:             ${tokens_saved} tokens (${savings_pct.toFixed(1)}%)`);
    console.log();
    console.log(`══ Composite: ${composite} / 10.00 ══`);
    console.log('=' .repeat(66));
    console.log('\nStored samples:');
    stored.slice(0, 3).forEach((s, i) => {
      console.log(`  [${i + 1}] title="${s.title.slice(0, 30)}…"`);
      console.log(`      content="${s.content.slice(0, 50)}…"`);
    });

    assert.ok(title_rate >= 0.9, `title clean rate ${(title_rate * 100).toFixed(0)}% < 90%`);
    assert.ok(content_rate >= 0.9, `content clean rate ${(content_rate * 100).toFixed(0)}% < 90%`);
    assert.ok(body_rate >= 0.9, `body preserved rate ${(body_rate * 100).toFixed(0)}% < 90%`);
    assert.ok(composite >= 8.5, `composite ${composite} < 8.5`);
  });
});
