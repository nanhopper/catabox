import { readFile } from 'node:fs/promises';
import {
  DIFF_LABELS,
  GENERATED_PATHS,
  PLATFORM_IDS,
  TIER_IDS,
  isMainModule,
  stableStringify
} from './constants.mjs';

function tierUnion(rawLists, tierId) {
  return [...new Set(PLATFORM_IDS.flatMap((platformId) => rawLists?.[tierId]?.[platformId] ?? []))].sort();
}

function add(collection, message) {
  collection.push(message);
}

function validateRequiredShape(current, errors) {
  for (const field of ['generatedAt', 'catalogHash', 'market', 'language', 'counts', 'labels', 'sourceLists', 'rawLists', 'games', 'diffs', 'segments', 'metadata']) {
    if (!(field in current)) {
      add(errors, `current.json is missing required field: ${field}`);
    }
  }
  if (!Array.isArray(current.games)) {
    add(errors, 'current.games must be an array');
  }
}

function validateSources(current, errors) {
  const sourceLists = current.sourceLists ?? [];
  const expected = TIER_IDS.length * PLATFORM_IDS.length;
  if (sourceLists.length !== expected) {
    add(errors, `Expected ${expected} SIGLS source lists, found ${sourceLists.length}`);
  }
  for (const tierId of TIER_IDS) {
    for (const platformId of PLATFORM_IDS) {
      const source = sourceLists.find((item) => item.tier === tierId && item.platform === platformId);
      if (!source) {
        add(errors, `Missing SIGLS source list for ${tierId}/${platformId}`);
      } else if (source.status !== 'ok') {
        add(errors, `SIGLS source list for ${tierId}/${platformId} is not ok`);
      }
    }
  }
}

function validateCounts(current, errors) {
  const rawLists = current.rawLists ?? {};
  const games = Array.isArray(current.games) ? current.games : [];
  const gameIds = new Set(games.map((game) => game.id));
  if (current.counts?.total !== games.length) {
    add(errors, `counts.total (${current.counts?.total}) does not match games length (${games.length})`);
  }
  for (const tierId of TIER_IDS) {
    const union = tierUnion(rawLists, tierId);
    if ((rawLists[tierId]?.all?.length ?? 0) !== union.length) {
      add(errors, `rawLists.${tierId}.all does not match ${tierId} console/pc union`);
    }
    if (current.counts?.tiers?.[tierId] !== union.length) {
      add(errors, `counts.tiers.${tierId} (${current.counts?.tiers?.[tierId]}) does not match raw list union (${union.length})`);
    }
    for (const id of union) {
      if (!gameIds.has(id)) {
        add(errors, `rawLists.${tierId} references missing game ${id}`);
      }
    }
  }
  for (const [diffId, ids] of Object.entries(current.diffs ?? {})) {
    for (const id of ids ?? []) {
      if (!gameIds.has(id)) {
        add(errors, `diffs.${diffId} references missing game ${id}`);
      }
    }
  }
  for (const [segmentId, ids] of Object.entries(current.segments ?? {})) {
    for (const id of ids ?? []) {
      if (!gameIds.has(id)) {
        add(errors, `segments.${segmentId} references missing game ${id}`);
      }
    }
  }
}

function validateWarnings(current, previousCurrent, warnings) {
  for (const diffId of ['premiumNotUltimate', 'essentialNotPremium', 'essentialNotUltimate']) {
    const count = current.diffs?.[diffId]?.length ?? 0;
    if (count > 0) {
      add(warnings, `${DIFF_LABELS[diffId]} is non-zero (${count}). This may be expected if public SIGLS behavior changes.`);
    }
  }
  const previousTotal = previousCurrent?.counts?.total;
  const currentTotal = current.counts?.total;
  if (typeof previousTotal === 'number' && previousTotal > 0 && typeof currentTotal === 'number') {
    const swing = Math.abs(currentTotal - previousTotal) / previousTotal;
    if (swing > 0.2) {
      add(warnings, `Union count changed by ${(swing * 100).toFixed(1)}% (${previousTotal} -> ${currentTotal}).`);
    }
  }
}

function validateHistory(history, errors) {
  if (!history) {
    return;
  }
  const knownIds = new Set(Object.keys(history.games ?? {}));
  for (const event of history.events ?? []) {
    if (!knownIds.has(event.productId)) {
      add(errors, `history event ${event.id ?? '(no id)'} references unknown product ${event.productId}`);
    }
  }
  for (const snapshot of history.snapshots ?? []) {
    if (!snapshot.path?.startsWith('snapshots/')) {
      add(errors, `history snapshot has invalid path: ${snapshot.path}`);
    }
  }
}

export function validateCatalog({ current, previousCurrent = null, history = null }) {
  const errors = [];
  const warnings = [];
  if (!current) {
    return { errors: ['current catalog is missing'], warnings };
  }
  validateRequiredShape(current, errors);
  validateSources(current, errors);
  validateCounts(current, errors);
  validateWarnings(current, previousCurrent, warnings);
  validateHistory(history, errors);
  return { errors, warnings };
}

export async function validateDeterministicJson(filePaths) {
  const errors = [];
  for (const filePath of filePaths) {
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const parsed = JSON.parse(text);
    const expected = stableStringify(parsed);
    if (text !== expected) {
      errors.push(`${filePath} is not deterministic/stably formatted`);
    }
  }
  return errors;
}

function parseCliArgs(argv) {
  const args = {
    current: GENERATED_PATHS.current,
    history: GENERATED_PATHS.history,
    previous: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current') {
      args.current = argv[++index];
    } else if (arg === '--history') {
      args.history = argv[++index];
    } else if (arg === '--previous') {
      args.previous = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function readJson(filePath, required = false) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && !required) {
      return null;
    }
    throw error;
  }
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const current = await readJson(args.current, true);
  const history = await readJson(args.history);
  const previousCurrent = args.previous ? await readJson(args.previous) : null;
  const result = validateCatalog({ current, previousCurrent, history });
  result.errors.push(...await validateDeterministicJson([args.current, args.history, GENERATED_PATHS.status]));
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
