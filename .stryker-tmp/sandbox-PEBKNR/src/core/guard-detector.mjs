// @ts-nocheck
const GENERIC_GUARD_RULES = [];
const AWARENESS_GUARD_RULES = [
  {
    id: 'pitfall_prisma_db_push',
    severity: 'high',
    mustBlock: true,
    title: 'Avoid prisma db push',
    match({ normalizedText }) {
      return normalizedText.includes('prisma db push');
    },
    buildSignal() {
      return {
        type: 'guard',
        guard_id: 'pitfall_prisma_db_push',
        reference_id: 'pitfall_prisma_db_push',
        severity: 'high',
        must_block: true,
        title: 'Avoid prisma db push',
        message: '🛑 Guard: never run prisma db push here. Use a reviewed manual SQL migration instead.',
      };
    },
  },
  {
    id: 'pitfall_ssh_nohup_build',
    severity: 'medium',
    mustBlock: false,
    title: 'Avoid foreground Docker build over SSH',
    match(normalized) {
      return isSshDockerBuild(normalized);
    },
    buildSignal(normalized) {
      const context = detectDockerContext(normalized);
      return {
        type: 'guard',
        guard_id: 'pitfall_ssh_nohup_build',
        reference_id: 'pitfall_ssh_nohup_build',
        severity: 'medium',
        must_block: false,
        title: 'Avoid foreground Docker build over SSH',
        message: buildDockerGuardMessage(context),
      };
    },
  },
  {
    id: 'pitfall_frontend_no_deps',
    severity: 'medium',
    mustBlock: false,
    title: 'Frontend prod deploy should use --no-deps',
    match(normalized) {
      return isFrontendDeployMissingNoDeps(normalized);
    },
    buildSignal() {
      return {
        type: 'guard',
        guard_id: 'pitfall_frontend_no_deps',
        reference_id: 'pitfall_frontend_no_deps',
        severity: 'medium',
        must_block: false,
        title: 'Frontend prod deploy should use --no-deps',
        message: '⚠️ Guard: frontend-only prod deploys here should use docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d --no-deps frontend to avoid restarting linked services such as postgres.',
      };
    },
  },
  {
    id: 'pitfall_missing_env_prod',
    severity: 'high',
    mustBlock: true,
    title: 'Prod deploy commands must include --env-file .env.prod',
    match(normalized) {
      return isProdCommandMissingEnvFile(normalized);
    },
    buildSignal() {
      return {
        type: 'guard',
        guard_id: 'pitfall_missing_env_prod',
        reference_id: 'pitfall_missing_env_prod',
        severity: 'high',
        must_block: true,
        title: 'Prod deploy commands must include --env-file .env.prod',
        message: '🛑 Guard: production docker compose commands here must include --env-file .env.prod, otherwise Compose may read .env and apply inconsistent runtime settings.',
      };
    },
  },
  {
    id: 'pitfall_prod_postgres_recreate',
    severity: 'high',
    mustBlock: true,
    title: 'Never include postgres in prod redeploy commands',
    match(normalized) {
      return isProdCommandRecreatingPostgres(normalized);
    },
    buildSignal() {
      return {
        type: 'guard',
        guard_id: 'pitfall_prod_postgres_recreate',
        reference_id: 'pitfall_prod_postgres_recreate',
        severity: 'high',
        must_block: true,
        title: 'Never include postgres in prod redeploy commands',
        message: '🛑 Guard: do not include postgres in production docker compose up commands here. Redeploy only backend/mcp/worker/beat, and add frontend separately when needed.',
      };
    },
  },
];

export function detectGuardSignals(input = {}, options = {}) {
  const normalized = normalizeGuardInput(input);
  const rules = resolveGuardRules(options.profile || input.guardProfile || process.env.AWARENESS_LOCAL_GUARD_PROFILE || 'generic');
  const signals = [];

  for (const rule of rules) {
    if (!rule.match(normalized)) continue;
    signals.push(rule.buildSignal(normalized));
  }

  return dedupeGuardSignals(signals);
}

function resolveGuardRules(profile) {
  if (profile === 'awareness') {
    return [...GENERIC_GUARD_RULES, ...AWARENESS_GUARD_RULES];
  }
  return GENERIC_GUARD_RULES;
}

function normalizeGuardInput(input) {
  const normalizedTags = new Set();
  for (const value of collectTags(input)) {
    const normalizedTag = normalizeText(value);
    if (normalizedTag) normalizedTags.add(normalizedTag);
  }

  return {
    rawTextLower: String([
      input.title,
      input.content,
    ].filter(Boolean).join(' ')).toLowerCase(),
    normalizedText: normalizeText([
      input.title,
      input.content,
    ].filter(Boolean).join(' ')),
    normalizedTags,
  };
}

function collectTags(input) {
  const values = [];
  if (Array.isArray(input.tags)) values.push(...input.tags);

  const cards = Array.isArray(input.insights?.knowledge_cards)
    ? input.insights.knowledge_cards
    : [];
  for (const card of cards) {
    if (Array.isArray(card?.tags)) values.push(...card.tags);
  }
  return values;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSshDockerBuild(normalized) {
  const text = normalized.normalizedText;
  const tags = normalized.normalizedTags;
  const hasDockerBuild = text.includes('docker build') || text.includes('docker compose build');
  if (!hasDockerBuild) return false;

  const hasSsh = text.includes('ssh') || tags.has('ssh');
  const hasRemoteFailureHint = text.includes('foreground')
    || text.includes('disconnected')
    || text.includes('disconnect')
    || text.includes('hangup')
    || text.includes('logout')
    || text.includes('log out')
    || text.includes('lost connection');

  return hasSsh && hasRemoteFailureHint;
}

function isFrontendDeployMissingNoDeps(normalized) {
  const text = normalized.normalizedText;
  const tags = normalized.normalizedTags;
  const isProd = detectDockerContext(normalized) === 'prod';
  if (!isProd) return false;

  const hasComposeUp = text.includes('docker compose') && text.includes(' up ');
  const mentionsFrontend = text.includes('frontend') || tags.has('frontend');
  const hasNoDeps = text.includes('--no-deps') || text.includes(' no-deps ');
  const isFrontendOnlyStyle = mentionsFrontend && !text.includes(' backend worker beat mcp frontend');

  return hasComposeUp && mentionsFrontend && isFrontendOnlyStyle && !hasNoDeps;
}

function isProdCommandMissingEnvFile(normalized) {
  const raw = normalized.rawTextLower;
  const tags = normalized.normalizedTags;
  const hasDockerCompose = raw.includes('docker compose');
  if (!hasDockerCompose) return false;

  const isDeployAction = raw.includes(' up ')
    || raw.includes(' restart ')
    || raw.includes(' start ')
    || raw.includes(' down ');
  if (!isDeployAction) return false;

  const prodSignal = raw.includes('docker-compose.prod.yml')
    || raw.includes('production')
    || raw.includes('prod deploy')
    || tags.has('prod')
    || tags.has('production')
    || tags.has('deploy');
  if (!prodSignal) return false;

  return !raw.includes('--env-file .env.prod');
}

function isProdCommandRecreatingPostgres(normalized) {
  const raw = normalized.rawTextLower;
  const tags = normalized.normalizedTags;
  const hasComposeUp = raw.includes('docker compose') && raw.includes(' up ');
  if (!hasComposeUp) return false;

  const prodSignal = raw.includes('docker-compose.prod.yml')
    || raw.includes('--env-file .env.prod')
    || tags.has('prod')
    || tags.has('production')
    || tags.has('deploy');
  if (!prodSignal) return false;

  return /\spostgres(\s|$)/.test(raw);
}

function detectDockerContext(normalized) {
  const text = normalized.normalizedText;
  const tags = normalized.normalizedTags;

  const isLocalDev = text.includes('docker compose local yml')
    || text.includes('docker compose override yml')
    || text.includes('docker_volume_directory')
    || text.includes('localhost')
    || tags.has('local')
    || tags.has('dev')
    || tags.has('development');

  if (isLocalDev) return 'local';

  const isProd = text.includes('docker compose prod yml')
    || text.includes('env prod')
    || text.includes('production')
    || text.includes('deploy')
    || tags.has('deploy')
    || tags.has('prod')
    || tags.has('production');

  if (isProd) return 'prod';
  return 'general';
}

function buildDockerGuardMessage(context) {
  if (context === 'local') {
    return '⚠️ Guard: local dev Docker rebuilds should run in a local terminal, not as a foreground SSH job. For this repo use DOCKER_VOLUME_DIRECTORY=. docker compose ... locally, and keep prod-only compose files out of the dev path.';
  }
  if (context === 'prod') {
    return '⚠️ Guard: do not run long Docker builds in the foreground over SSH. For prod here use nohup plus docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod ..., then bring up only the target services.';
  }
  return '⚠️ Guard: avoid foreground Docker builds over SSH. Use nohup for remote builds, and choose the repo-specific dev or prod compose path instead of mixing them.';
}

function dedupeGuardSignals(signals) {
  const seen = new Set();
  return signals.filter((signal) => {
    const key = signal.guard_id || signal.reference_id || signal.title || signal.message;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { AWARENESS_GUARD_RULES, GENERIC_GUARD_RULES };