/**
 * F-038 Phase 0 深度集成测试
 *
 * 1. 真实项目目录扫描（用 Awareness 项目自身）
 * 2. 复杂图结构 + graphTraverse 边界场景
 * 3. recall_count 排序验证（高频卡片排在前面）
 * 4. 全管道集成：gitignore + 过滤 + 分类 + schema + 搜索
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Indexer } from '../src/core/indexer.mjs';
import { loadGitignoreRules } from '../src/core/gitignore-parser.mjs';
import { getFileCategory, isExcludedDir, isExcludedFile, isSensitiveFile, classifyFile } from '../src/core/scan-defaults.mjs';
import { loadScanConfig, saveScanConfig } from '../src/core/scan-config.mjs';
import { ensureLocalDirs } from '../src/core/config.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f038-integration-'));
// Awareness 项目根目录
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. 真实项目目录扫描集成测试
// ---------------------------------------------------------------------------

describe('集成测试: 真实项目扫描管道', () => {
  it('扫描 Awareness sdks/local/src/ 目录，正确分类所有文件', () => {
    const srcDir = path.join(PROJECT_ROOT, 'sdks/local/src');
    if (!fs.existsSync(srcDir)) return; // CI 环境可能路径不同

    const filter = loadGitignoreRules(PROJECT_ROOT);
    const config = loadScanConfig(PROJECT_ROOT);
    const results = { code: 0, docs: 0, config: 0, convertible: 0, excluded: 0, ignored: 0 };

    function walkDir(dir, relativeTo) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(relativeTo, fullPath);

        if (entry.isDirectory()) {
          if (isExcludedDir(entry.name)) continue;
          walkDir(fullPath, relativeTo);
        } else {
          if (filter.isIgnored(relPath)) { results.ignored++; continue; }
          const classification = classifyFile(relPath, config);
          if (classification.excluded) { results.excluded++; continue; }
          results[classification.category]++;
        }
      }
    }

    walkDir(srcDir, PROJECT_ROOT);

    // sdks/local/src/ 主要是 .mjs 文件（code）
    assert.ok(results.code > 10, `应该有 >10 个代码文件，实际 ${results.code}`);
    assert.ok(results.excluded >= 0, '排除数量应该 >=0');
    console.log(`[集成] sdks/local/src/ 扫描结果: code=${results.code}, docs=${results.docs}, config=${results.config}, excluded=${results.excluded}, ignored=${results.ignored}`);
  });

  it('gitignore 正确排除 node_modules 和 .awareness 内容', () => {
    const filter = loadGitignoreRules(PROJECT_ROOT);
    // node_modules 在 .gitignore 中
    assert.equal(filter.isIgnored('node_modules/express/index.js'), true);
    // .awareness 内部文件应该被排除（如果 .gitignore 包含它）
    assert.equal(isExcludedDir('.awareness'), true);
  });

  it('敏感文件检测覆盖项目中可能出现的类型', () => {
    // 项目中使用的密钥文件类型
    assert.equal(isSensitiveFile('server-key/awareness_teammate_key'), false); // 不在 SENSITIVE_PATTERNS 中
    assert.equal(isSensitiveFile('.env.prod'), true);
    assert.equal(isSensitiveFile('.env'), true);
    assert.equal(isSensitiveFile('config/credentials.json'), true);
  });

  it('.awareness 目录扩展后包含 documents/ 和 workspace/', () => {
    const testProject = path.join(tmpDir, 'test-project');
    fs.mkdirSync(testProject, { recursive: true });
    ensureLocalDirs(testProject);

    assert.ok(fs.existsSync(path.join(testProject, '.awareness/documents')));
    assert.ok(fs.existsSync(path.join(testProject, '.awareness/workspace')));

    // .gitignore 应包含新条目
    const gitignore = fs.readFileSync(path.join(testProject, '.awareness/.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('scan-state.json'));
    assert.ok(gitignore.includes('documents/'));
    assert.ok(gitignore.includes('workspace/'));
  });
});

// ---------------------------------------------------------------------------
// 2. 复杂图结构 + graphTraverse 边界场景
// ---------------------------------------------------------------------------

describe('数据模拟: 复杂图结构', () => {
  let indexer;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'complex-graph.db'));

    // 构建模拟 Awareness 项目的图结构
    // 文件节点
    const files = [
      { id: 'f_indexer', node_type: 'file', title: 'indexer.mjs', content: 'SQLite FTS5 search index', metadata: { path: 'src/core/indexer.mjs', lines: 1600 } },
      { id: 'f_memstore', node_type: 'file', title: 'memory-store.mjs', content: 'File-based memory storage', metadata: { path: 'src/core/memory-store.mjs', lines: 400 } },
      { id: 'f_daemon', node_type: 'file', title: 'daemon.mjs', content: 'HTTP daemon and MCP server', metadata: { path: 'src/daemon/daemon.mjs', lines: 800 } },
      { id: 'f_cloudsync', node_type: 'file', title: 'cloud-sync.mjs', content: 'Cloud synchronization service', metadata: { path: 'src/core/cloud-sync.mjs', lines: 600 } },
      { id: 'f_watcher', node_type: 'file', title: 'file-watcher.mjs', content: 'File system watcher for changes', metadata: { path: 'src/daemon/file-watcher.mjs', lines: 200 } },
      { id: 'f_config', node_type: 'file', title: 'config.mjs', content: 'Configuration manager', metadata: { path: 'src/core/config.mjs', lines: 400 } },
      { id: 'f_scanner', node_type: 'file', title: 'gitignore-parser.mjs', content: 'Gitignore pattern parser', metadata: { path: 'src/core/gitignore-parser.mjs', lines: 158 } },
    ];

    // 符号节点
    const symbols = [
      { id: 's_search', node_type: 'symbol', title: 'searchKnowledge()', content: 'FTS5 search over knowledge cards with BM25 ranking' },
      { id: 's_traverse', node_type: 'symbol', title: 'graphTraverse()', content: 'WITH RECURSIVE graph traversal' },
      { id: 's_index', node_type: 'symbol', title: 'incrementalIndex()', content: 'Incremental indexing of memory files' },
    ];

    // 知识卡片节点
    const cards = [
      { id: 'c_fts5', node_type: 'card', title: 'FTS5 ft.rank 是无效列', content: '必须用 bm25() 函数', metadata: { category: 'pitfall' } },
      { id: 'c_tsquery', node_type: 'card', title: 'plainto_tsquery 用 simple 不用 english', content: '中文搜索需要 simple 分析器', metadata: { category: 'pitfall' } },
      { id: 'c_dedup', node_type: 'card', title: 'merge-first 写入策略', content: '后端四层 dedup + enrich', metadata: { category: 'decision' } },
    ];

    // 文档节点
    const docs = [
      { id: 'd_claude', node_type: 'doc', title: 'CLAUDE.md', content: '项目规则和踩坑记录' },
      { id: 'd_design', node_type: 'doc', title: 'scan-engine-design.md', content: 'F-038 扫描引擎设计' },
    ];

    for (const n of [...files, ...symbols, ...cards, ...docs]) {
      indexer.graphInsertNode(n);
    }

    // 边：import 关系
    const imports = [
      { from_node_id: 'f_daemon', to_node_id: 'f_indexer', edge_type: 'import' },
      { from_node_id: 'f_daemon', to_node_id: 'f_memstore', edge_type: 'import' },
      { from_node_id: 'f_daemon', to_node_id: 'f_watcher', edge_type: 'import' },
      { from_node_id: 'f_daemon', to_node_id: 'f_cloudsync', edge_type: 'import' },
      { from_node_id: 'f_daemon', to_node_id: 'f_config', edge_type: 'import' },
      { from_node_id: 'f_indexer', to_node_id: 'f_memstore', edge_type: 'import' },
      { from_node_id: 'f_cloudsync', to_node_id: 'f_indexer', edge_type: 'import' },
      { from_node_id: 'f_watcher', to_node_id: 'f_indexer', edge_type: 'import' },
    ];

    // 边：contains（文件包含符号）
    const contains = [
      { from_node_id: 'f_indexer', to_node_id: 's_search', edge_type: 'contains' },
      { from_node_id: 'f_indexer', to_node_id: 's_traverse', edge_type: 'contains' },
      { from_node_id: 'f_indexer', to_node_id: 's_index', edge_type: 'contains' },
    ];

    // 边：doc_reference（文档引用代码）
    const docRefs = [
      { from_node_id: 'd_claude', to_node_id: 'c_fts5', edge_type: 'doc_reference' },
      { from_node_id: 'd_claude', to_node_id: 'c_tsquery', edge_type: 'doc_reference' },
      { from_node_id: 'd_design', to_node_id: 'f_scanner', edge_type: 'doc_reference' },
      { from_node_id: 'd_design', to_node_id: 'f_indexer', edge_type: 'doc_reference' },
    ];

    // 边：similarity（知识卡片相似）
    const similarities = [
      { from_node_id: 'c_fts5', to_node_id: 'c_tsquery', edge_type: 'similarity', weight: 0.85 },
      { from_node_id: 'c_fts5', to_node_id: 's_search', edge_type: 'similarity', weight: 0.72 },
    ];

    for (const e of [...imports, ...contains, ...docRefs, ...similarities]) {
      indexer.graphInsertEdge(e);
    }
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('从 indexer.mjs 出发，1 跳找到直接关联', () => {
    const result = indexer.graphTraverse('f_indexer', { maxDepth: 1 });
    const ids = result.map(r => r.id);

    // import 链：daemon, cloudsync, watcher 都 import indexer
    assert.ok(ids.includes('f_daemon'), 'daemon imports indexer');
    assert.ok(ids.includes('f_cloudsync'), 'cloudsync imports indexer');
    assert.ok(ids.includes('f_watcher'), 'watcher imports indexer');
    assert.ok(ids.includes('f_memstore'), 'indexer imports memstore');

    // contains：符号
    assert.ok(ids.includes('s_search'), 'indexer contains searchKnowledge');
    assert.ok(ids.includes('s_traverse'), 'indexer contains graphTraverse');

    // doc_reference
    assert.ok(ids.includes('d_design'), 'design doc references indexer');

    console.log(`[模拟] indexer 1跳关联: ${ids.length} 个节点`);
  });

  it('从踩坑卡片出发，2 跳找到相关代码和文档', () => {
    // 场景：调试 bug 时，从踩坑记录自动关联到代码文件
    const result = indexer.graphTraverse('c_fts5', { maxDepth: 2 });
    const ids = result.map(r => r.id);

    // 1跳: c_tsquery（similarity）, s_search（similarity）, d_claude（doc_reference reverse）
    assert.ok(ids.includes('c_tsquery'), 'similar pitfall card');
    assert.ok(ids.includes('s_search'), 'related function');
    assert.ok(ids.includes('d_claude'), 'documentation reference');

    // 2跳: f_indexer（s_search → contains → f_indexer）, c_dedup 不应出现
    assert.ok(ids.includes('f_indexer'), '2跳到达 indexer.mjs');

    console.log(`[模拟] c_fts5 2跳关联: ${result.map(r => `${r.id}(d=${r.depth})`).join(', ')}`);
  });

  it('只遍历 import 边，跳过其他类型', () => {
    const result = indexer.graphTraverse('f_daemon', { maxDepth: 2, edgeTypes: ['import'] });
    const ids = result.map(r => r.id);

    // 1跳: indexer, memstore, watcher, cloudsync, config
    assert.ok(ids.includes('f_indexer'));
    assert.ok(ids.includes('f_memstore'));
    // 2跳: indexer → memstore（已有）, cloudsync → indexer（已有）
    // 不应包含符号节点（contains 边被过滤）
    assert.ok(!ids.includes('s_search'), '不应通过 import 边到达 symbol');
    assert.ok(!ids.includes('d_claude'), '不应通过 import 边到达 doc');
  });

  it('graph 搜索找到相关节点', () => {
    const results = indexer.searchGraphNodes('FTS5');
    assert.ok(results.length > 0);
    // 应该找到 indexer.mjs 和 FTS5 pitfall 卡片
    const ids = results.map(r => r.id);
    assert.ok(ids.includes('f_indexer') || ids.includes('c_fts5'),
      '搜索 FTS5 应该找到 indexer 或踩坑卡片');
  });

  it('不存在的起点返回空数组', () => {
    assert.deepEqual(indexer.graphTraverse('nonexistent'), []);
  });

  it('孤立节点（无边）可以被搜索但不能被遍历', () => {
    indexer.graphInsertNode({ id: 'isolated', node_type: 'file', title: 'orphan.txt', content: 'No edges' });
    const traverseResult = indexer.graphTraverse('isolated', { maxDepth: 3 });
    assert.equal(traverseResult.length, 0, '孤立节点遍历应返回空');

    const searchResult = indexer.searchGraphNodes('orphan');
    assert.ok(searchResult.length > 0, '但搜索可以找到孤立节点');
  });

  it('环形图不会无限循环', () => {
    // A → B → C → A 形成环
    indexer.graphInsertNode({ id: 'cycle_a', node_type: 'file', title: 'a.ts' });
    indexer.graphInsertNode({ id: 'cycle_b', node_type: 'file', title: 'b.ts' });
    indexer.graphInsertNode({ id: 'cycle_c', node_type: 'file', title: 'c.ts' });
    indexer.graphInsertEdge({ from_node_id: 'cycle_a', to_node_id: 'cycle_b', edge_type: 'import' });
    indexer.graphInsertEdge({ from_node_id: 'cycle_b', to_node_id: 'cycle_c', edge_type: 'import' });
    indexer.graphInsertEdge({ from_node_id: 'cycle_c', to_node_id: 'cycle_a', edge_type: 'import' });

    const result = indexer.graphTraverse('cycle_a', { maxDepth: 10 });
    // 关键：不会无限循环（结果有限），且找到了 B 和 C
    assert.ok(result.length < 20, `不应无限循环，实际返回 ${result.length} 条`);
    const uniqueIds = new Set(result.map(r => r.id));
    assert.ok(uniqueIds.has('cycle_b'), '应找到 cycle_b');
    assert.ok(uniqueIds.has('cycle_c'), '应找到 cycle_c');
    assert.ok(!uniqueIds.has('cycle_a'), '不应包含起点自身');
  });
});

// ---------------------------------------------------------------------------
// 3. recall_count 排序验证
// ---------------------------------------------------------------------------

describe('数据模拟: recall_count 排序影响', () => {
  let indexer;

  before(() => {
    indexer = new Indexer(path.join(tmpDir, 'recall-sort.db'));

    const now = new Date().toISOString();
    // 插入 3 张相同关键词的卡片，不同 recall_count
    const cards = [
      { id: 'low_rc', recall_count: 0, link_incoming: 0, title: 'Database migration guide', summary: 'How to run database migration safely' },
      { id: 'mid_rc', recall_count: 5, link_incoming: 2, title: 'Database migration pitfall', summary: 'Common pitfall in database migration process' },
      { id: 'high_rc', recall_count: 50, link_incoming: 5, title: 'Database migration checklist', summary: 'Complete database migration verification checklist' },
    ];

    for (const c of cards) {
      indexer.db.prepare(`
        INSERT INTO knowledge_cards (id, category, title, summary, source_memories, confidence, status, tags, created_at, filepath, recall_count, link_count_incoming)
        VALUES (?, 'workflow', ?, ?, '[]', 0.8, 'active', '["database","migration"]', ?, ?, ?, ?)
      `).run(c.id, c.title, c.summary, now, `/test/${c.id}.md`, c.recall_count, c.link_incoming);

      indexer.db.prepare(`
        INSERT INTO knowledge_fts (id, title, summary, content, tags)
        VALUES (?, ?, ?, ?, ?)
      `).run(c.id, c.title, c.summary, c.summary, '["database","migration"]');
    }
  });

  after(() => {
    if (indexer?.db) indexer.db.close();
  });

  it('高 recall_count 的卡片排在前面', () => {
    const results = indexer.searchKnowledge('database migration');
    assert.ok(results.length === 3, `应该找到 3 张卡片，实际 ${results.length}`);

    // weighted_rank 排序：高 recall_count 的应该排前面
    const order = results.map(r => r.id);
    console.log(`[排序] 搜索结果顺序: ${order.join(' > ')}`);
    console.log(`[排序] weighted_rank: ${results.map(r => `${r.id}=${r.weighted_rank?.toFixed(3)}`).join(', ')}`);

    // high_rc (recall_count=50) 应该在 low_rc (recall_count=0) 前面
    const highIdx = order.indexOf('high_rc');
    const lowIdx = order.indexOf('low_rc');
    assert.ok(highIdx < lowIdx, `high_rc(rc=50) 应在 low_rc(rc=0) 前面，实际 high=${highIdx}, low=${lowIdx}`);
  });

  it('搜索命中后 recall_count 自动递增', () => {
    const beforeSearch = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('low_rc');
    const initialCount = beforeSearch.recall_count;

    indexer.searchKnowledge('database migration');

    const afterSearch = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('low_rc');
    assert.ok(afterSearch.recall_count > initialCount,
      `recall_count 应递增: before=${initialCount}, after=${afterSearch.recall_count}`);
  });

  it('多次搜索累积递增 recall_count', () => {
    const before = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('mid_rc');

    // 搜索 3 次
    indexer.searchKnowledge('database migration');
    indexer.searchKnowledge('database migration');
    indexer.searchKnowledge('database migration');

    const after = indexer.db.prepare('SELECT recall_count FROM knowledge_cards WHERE id = ?').get('mid_rc');
    assert.equal(after.recall_count, before.recall_count + 3,
      `3 次搜索应累加 3: before=${before.recall_count}, after=${after.recall_count}`);
  });
});

// ---------------------------------------------------------------------------
// 4. scan-config 与 gitignore 联动
// ---------------------------------------------------------------------------

describe('集成测试: scan-config + gitignore 联动', () => {
  it('scan-config 的 exclude 模式通过 gitignore 解析器应用', () => {
    const dir = path.join(tmpDir, 'config-gitignore');
    fs.mkdirSync(dir, { recursive: true });

    // 保存 scan-config 带 exclude
    saveScanConfig(dir, {
      exclude: ['test/fixtures/**', 'legacy/**'],
    });

    const config = loadScanConfig(dir);
    const filter = loadGitignoreRules(dir, { extraPatterns: config.exclude });

    // 正常文件不被排除
    assert.equal(filter.isIgnored('src/main.ts'), false);
    // exclude 中的文件被排除
    assert.equal(filter.isIgnored('test/fixtures/sample.json'), true);
    assert.equal(filter.isIgnored('legacy/old-code.js'), true);
  });

  it('scan-config 类别开关正确过滤文件', () => {
    const config = { scan_code: true, scan_docs: true, scan_config: false, scan_convertible: false };

    assert.equal(classifyFile('app.ts', config).excluded, false);
    assert.equal(classifyFile('README.md', config).excluded, false);
    assert.equal(classifyFile('package.json', config).excluded, true); // config disabled
    assert.equal(classifyFile('report.pdf', config).excluded, true);   // convertible disabled
  });
});

// ---------------------------------------------------------------------------
// 5. Schema 升级兼容性
// ---------------------------------------------------------------------------

describe('Schema 升级兼容性', () => {
  it('在已有数据的 DB 上运行 initSchema 不丢数据', () => {
    const dbPath = path.join(tmpDir, 'upgrade-compat.db');

    // 第一次创建 — 模拟旧版本 DB
    const indexer1 = new Indexer(dbPath);
    const now = new Date().toISOString();

    // 插入 memories 和 knowledge_cards
    indexer1.db.prepare(`
      INSERT INTO memories (id, filepath, type, title, created_at, updated_at)
      VALUES ('mem_old', '/old/mem.md', 'event', 'Old Memory', ?, ?)
    `).run(now, now);

    indexer1.db.prepare(`
      INSERT INTO knowledge_cards (id, category, title, summary, source_memories, confidence, status, tags, created_at, filepath)
      VALUES ('kc_old', 'decision', 'Old Decision', 'Legacy card', '[]', 0.9, 'active', '[]', ?, '/old/kc.md')
    `).run(now);

    // 插入 graph 数据
    indexer1.graphInsertNode({ id: 'gn_old', node_type: 'file', title: 'old-file.ts' });
    indexer1.graphInsertEdge({ from_node_id: 'gn_old', to_node_id: 'gn_old', edge_type: 'similarity' });

    indexer1.db.close();

    // 第二次打开 — 模拟升级
    const indexer2 = new Indexer(dbPath);

    // 验证旧数据完整
    const mem = indexer2.db.prepare('SELECT * FROM memories WHERE id = ?').get('mem_old');
    assert.ok(mem, '旧 memory 应该保留');
    assert.equal(mem.title, 'Old Memory');

    const kc = indexer2.db.prepare('SELECT * FROM knowledge_cards WHERE id = ?').get('kc_old');
    assert.ok(kc, '旧 knowledge_card 应该保留');
    assert.ok('recall_count' in kc, 'recall_count 列应该存在');
    assert.equal(kc.recall_count, 0, 'recall_count 默认 0');

    const gn = indexer2.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('gn_old');
    assert.ok(gn, '旧 graph_node 应该保留');

    // 新数据可以插入
    indexer2.graphInsertNode({ id: 'gn_new', node_type: 'symbol', title: 'newFunc()' });
    const newNode = indexer2.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get('gn_new');
    assert.ok(newNode);

    indexer2.db.close();
  });
});
