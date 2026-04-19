import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { fileURLToPath } from 'node:url';

import { detectGuardSignals } from '../src/core/guard-detector.mjs';
import { AwarenessLocalDaemon } from '../src/daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const perceptionCases = loadPerceptionCases();

test('detectGuardSignals matches known prisma db push guard fixture', () => {
  const sample = getCase('signal-001');

  const signals = detectGuardSignals(sample.input_event, { profile: 'awareness' });

  assert.equal(signals.length, 1);
  assert.equal(signals[0].type, 'guard');
  assert.equal(signals[0].severity, sample.expected_severity);
  assert.equal(signals[0].must_block, sample.must_block);
  assert.equal(signals[0].reference_id, sample.must_reference[0]);
});

test('detectGuardSignals matches prod docker-over-ssh guard and references prod compose path', () => {
  const sample = getCase('signal-002');

  const signals = detectGuardSignals(sample.input_event, { profile: 'awareness' });
  const guard = signals.find((signal) => signal.type === 'guard');

  assert.ok(guard);
  assert.equal(guard.severity, sample.expected_severity);
  assert.equal(guard.must_block, sample.must_block);
  assert.equal(guard.reference_id, sample.must_reference[0]);
  assert.match(guard.message, /nohup/i);
  assert.match(guard.message, /docker-compose\.prod\.yml|docker compose -f docker-compose\.yml -f docker-compose\.prod\.yml/i);
  assert.match(guard.message, /env\.prod|env prod/i);
});

test('detectGuardSignals does not flag local docker compose work without ssh risk', () => {
  const signals = detectGuardSignals({
    title: '本地重建 backend',
    content: 'I am rebuilding locally with DOCKER_VOLUME_DIRECTORY=. docker compose up -d postgres redis qdrant backend worker.',
    tags: ['docker', 'local', 'dev'],
  }, { profile: 'awareness' });

  assert.equal(signals.some((signal) => signal.reference_id === 'pitfall_ssh_nohup_build'), false);
});

test('detectGuardSignals flags frontend prod deploys that omit --no-deps', () => {
  const signals = detectGuardSignals({
    title: 'Recreate prod frontend container',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d --force-recreate frontend',
    tags: ['deploy', 'prod', 'frontend'],
  }, { profile: 'awareness' });

  const guard = signals.find((signal) => signal.reference_id === 'pitfall_frontend_no_deps');
  assert.ok(guard);
  assert.match(guard.message, /--no-deps/);
  assert.match(guard.message, /frontend/);
});

test('detectGuardSignals allows frontend prod deploys that already include --no-deps', () => {
  const signals = detectGuardSignals({
    title: 'Safe prod frontend rollout',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps frontend',
    tags: ['deploy', 'prod', 'frontend'],
  }, { profile: 'awareness' });

  assert.equal(signals.some((signal) => signal.reference_id === 'pitfall_frontend_no_deps'), false);
});

test('detectGuardSignals flags prod deploy commands missing --env-file .env.prod', () => {
  const signals = detectGuardSignals({
    title: 'Deploy backend on production',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend worker beat mcp',
    tags: ['deploy', 'prod'],
  }, { profile: 'awareness' });

  const guard = signals.find((signal) => signal.reference_id === 'pitfall_missing_env_prod');
  assert.ok(guard);
  assert.equal(guard.must_block, true);
  assert.match(guard.message, /--env-file \.env\.prod/);
});

test('detectGuardSignals allows prod deploy commands that already include --env-file .env.prod', () => {
  const signals = detectGuardSignals({
    title: 'Safe backend deploy',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d backend worker beat mcp',
    tags: ['deploy', 'prod'],
  }, { profile: 'awareness' });

  assert.equal(signals.some((signal) => signal.reference_id === 'pitfall_missing_env_prod'), false);
});

test('detectGuardSignals flags prod deploy commands that include postgres', () => {
  const signals = detectGuardSignals({
    title: 'Bad full prod up command',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d postgres backend worker beat mcp',
    tags: ['deploy', 'prod'],
  }, { profile: 'awareness' });

  const guard = signals.find((signal) => signal.reference_id === 'pitfall_prod_postgres_recreate');
  assert.ok(guard);
  assert.equal(guard.must_block, true);
  assert.match(guard.message, /postgres/);
});

test('detectGuardSignals allows prod deploy commands that exclude postgres', () => {
  const signals = detectGuardSignals({
    title: 'Good prod service rollout',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d backend worker beat mcp frontend',
    tags: ['deploy', 'prod'],
  }, { profile: 'awareness' });

  assert.equal(signals.some((signal) => signal.reference_id === 'pitfall_prod_postgres_recreate'), false);
});

test('detectGuardSignals keeps repo-specific guards disabled by default', () => {
  const signals = detectGuardSignals({
    title: 'Deploy backend on production',
    content: 'docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend worker beat mcp',
    tags: ['deploy', 'prod'],
  });

  assert.equal(signals.length, 0);
});

test('daemon perception surfaces guard before related contradiction signals', async () => {
  const sample = getCase('signal-001');
  const daemon = createDaemon({
    searchKnowledge() {
      return [];
    },
    categoryCounts: {},
    superseded: [
      {
        id: 'superseded-card',
        title: 'Old schema migration shortcut',
        category: 'pitfall',
        summary: 'Prior shortcut is no longer valid.',
      },
    ],
    decisions: [],
  });

  const signals = await daemon._buildPerception(
    sample.input_event.content,
    sample.input_event.title,
    { tags: sample.input_event.tags },
    null,
  );

  assert.deepEqual(signals.map((signal) => signal.type), sample.expected_signals);
  assert.equal(signals[0].reference_id, sample.must_reference[0]);
  assert.equal(signals[0].must_block, true);
});

test('daemon perception keeps pattern and resonance fixture without false guard', async () => {
  const sample = getCase('signal-002');
  const daemon = createDaemon({
    searchKnowledge(query) {
      if (!String(query || '').includes('Docker')) return [];
      return [
        {
          id: 'pitfall_ssh_nohup_build',
          title: 'Docker build over SSH needs nohup',
          summary: 'Foreground SSH builds disconnect before completion.',
          category: 'pitfall',
          rank: -1.5,
          created_at: new Date(Date.now() - 86400000).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
    },
    categoryCounts: {
      pitfall: 3,
    },
    superseded: [],
    decisions: [],
    recentActiveCards: [
      { tags: '["docker","ssh","deploy"]' },
      { tags: '["docker","prod"]' },
      { tags: '["docker","ssh"]' },
      { tags: '["deploy","prod"]' },
    ],
  });

  const signals = await daemon._buildPerception(
    sample.input_event.content,
    sample.input_event.title,
    { tags: sample.input_event.tags },
    {
      knowledge_cards: [
        {
          category: 'pitfall',
          tags: sample.input_event.tags,
        },
      ],
    },
  );

  assert.deepEqual(
    [...signals.map((signal) => signal.type)].sort(),
    [...sample.expected_signals].sort(),
  );
  const guard = signals.find((signal) => signal.type === 'guard');
  assert.equal(guard?.reference_id, sample.must_reference[0]);
  assert.equal(guard?.must_block, sample.must_block);
  const resonance = signals.find((signal) => signal.type === 'resonance');
  assert.equal(resonance?.card_id, sample.must_reference[0]);
});

function loadPerceptionCases() {
  const datasetPath = path.resolve(__dirname, '../../../tests/memory-benchmark/datasets/perception_signals.jsonl');
  return fs.readFileSync(datasetPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getCase(id) {
  const sample = perceptionCases.find((item) => item.id === id);
  assert.ok(sample, `Missing perception sample: ${id}`);
  return sample;
}

function createDaemon(fixtures) {
  const daemon = new AwarenessLocalDaemon({ projectDir: process.cwd(), guardProfile: 'awareness' });
  daemon.indexer = {
    searchKnowledge: fixtures.searchKnowledge,
    db: {
      prepare(sql) {
        return {
          get(param) {
            if (sql.includes('COUNT(*) AS cnt FROM knowledge_cards WHERE category')) {
              return { cnt: fixtures.categoryCounts?.[param] || 0 };
            }
            return null;
          },
          all() {
            if (sql.includes("status = 'superseded'")) {
              return fixtures.superseded || [];
            }
            if (sql.includes("category = 'decision'")) {
              return fixtures.decisions || [];
            }
            if (sql.includes("status = 'active'") && sql.includes('-7 days')) {
              return fixtures.recentActiveCards || [];
            }
            return [];
          },
        };
      },
    },
  };
  return daemon;
}