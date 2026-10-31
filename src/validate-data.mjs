import { readFile } from 'node:fs/promises';
import {
  DIFF_DEFS,
  DIFF_LABELS,
  EXPECTED_SUBSET_DEFS,
  GENERATED_PATHS,
  HISTORY_SCHEMA_VERSION,
  MAX_GAME_SCREENSHOTS,
  OVERLAP_DEFS,
  PLATFORM_IDS,
  SEGMENT_IDS,
  TIER_IDS,
  TIER_SOURCE_PAIRS,
  isMainModule,
  segmentIdForTiers,
  stableStringify,
  tierSupportsPlatform
} from './constants.mjs';
import {
  GAME_FAMILY_SCHEMA_VERSION,
  buildFamilyCatalog
} from './game-families.mjs';

function tierUnion(rawLists, tierId) {
  return [...new Set(PLATFORM_IDS.flatMap((platformId) => rawLists?.[tierId]?.[platformId] ?? []))].sort();
}

function add(collection, message) {
  collection.push(message);
}

function sourceKey(tierId, platformId) {
  return `${tierId}:${platformId}`;
}

function sameSortedValues(left = [], right = []) {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function sameValues(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateRequiredShape(current, errors) {
  for (const field of [
    'generatedAt',
    'catalogHash',
    'familyHash',
    'market',
    'language',
    'counts',
    'familyCounts',
    'labels',
    'sourceLists',
    'rawLists',
    'games',
    'families',
    'diffs',
    'familyDiffs',
    'segments',
    'familySegments',
    'metadata'
  ]) {
    if (!(field in current)) {
      add(errors, `current.json is missing required field: ${field}`);
    }
  }
  if (!Array.isArray(current.games)) {
    add(errors, 'current.games must be an array');
  }
  if (!Array.isArray(current.families)) {
    add(errors, 'current.families must be an array');
  }
}

function validateLabels(current, errors) {
  const definitions = [
    ['tiers', TIER_IDS],
    ['platforms', PLATFORM_IDS],
    ['segments', SEGMENT_IDS],
    ['diffs', DIFF_DEFS.map((diff) => diff.id)]
  ];
  for (const [kind, expectedIds] of definitions) {
    const labels = current.labels?.[kind] ?? {};
    const expected = new Set(expectedIds);
    for (const id of expectedIds) {
      if (typeof labels[id] !== 'string' || labels[id].trim() === '') {
        add(errors, `labels.${kind}.${id} must be a non-empty string`);
      }
      if (!sameValues(current.metadata?.tierOrder, TIER_IDS)) {
        add(errors, `metadata.tierOrder must match configured tier order: ${TIER_IDS.join(', ')}`);
      }
      if (!sameValues(current.metadata?.platformOrder, PLATFORM_IDS)) {
        add(errors, `metadata.platformOrder must match configured platform order: ${PLATFORM_IDS.join(', ')}`);
      }
    }
    for (const id of Object.keys(labels)) {
      if (!expected.has(id)) {
        add(errors, `Unexpected ${kind} label: ${id}`);
      }
    }
  }
}

function validateSources(current, errors) {
  const sourceLists = current.sourceLists ?? [];
  const expected = TIER_SOURCE_PAIRS.length;
  if (sourceLists.length !== expected) {
    add(errors, `Expected ${expected} SIGLS source lists, found ${sourceLists.length}`);
  }
  const expectedKeys = new Set(TIER_SOURCE_PAIRS.map(({ tierId, platformId }) => sourceKey(tierId, platformId)));
  for (const { tierId, platformId } of TIER_SOURCE_PAIRS) {
    const matches = sourceLists.filter((item) => item.tier === tierId && item.platform === platformId);
    if (matches.length === 0) {
      add(errors, `Missing SIGLS source list for ${tierId}/${platformId}`);
    } else if (matches.length > 1) {
      add(errors, `Duplicate SIGLS source lists for ${tierId}/${platformId}`);
    } else if (matches[0].status !== 'ok') {
      add(errors, `SIGLS source list for ${tierId}/${platformId} is not ok`);
    }
  }
  for (const source of sourceLists) {
    if (!expectedKeys.has(sourceKey(source.tier, source.platform))) {
      add(errors, `Unexpected SIGLS source list for ${source.tier}/${source.platform}`);
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
    for (const platformId of PLATFORM_IDS) {
      if (!tierSupportsPlatform(tierId, platformId) && (rawLists[tierId]?.[platformId]?.length ?? 0) > 0) {
        add(errors, `rawLists.${tierId}.${platformId} must be empty because the source tuple is unsupported`);
      }
    }
  }

  const tierSets = Object.fromEntries(TIER_IDS.map((tierId) => [tierId, new Set(tierUnion(rawLists, tierId))]));
  const expectedOverlapIds = new Set(OVERLAP_DEFS.map((overlap) => overlap.id));
  for (const { id, leftTierId, rightTierId } of OVERLAP_DEFS) {
    const expectedIds = [...tierSets[leftTierId]].filter((productId) => tierSets[rightTierId].has(productId));
    const actualIds = current.metadata?.overlap?.[id] ?? [];
    if (!sameSortedValues(actualIds, expectedIds)) {
      add(errors, `metadata.overlap.${id} does not match ${leftTierId}/${rightTierId} intersection`);
    }
  }
  for (const overlapId of Object.keys(current.metadata?.overlap ?? {})) {
    if (!expectedOverlapIds.has(overlapId)) {
      add(errors, `Unexpected overlap definition: ${overlapId}`);
    }
  }

  const expectedDiffIds = new Set(DIFF_DEFS.map((diff) => diff.id));
  for (const { id, includedTierId, excludedTierId } of DIFF_DEFS) {
    const expectedIds = [...tierSets[includedTierId]].filter((productId) => !tierSets[excludedTierId].has(productId));
    const actualIds = current.diffs?.[id] ?? [];
    if (!sameSortedValues(actualIds, expectedIds)) {
      add(errors, `diffs.${id} does not match ${includedTierId} minus ${excludedTierId}`);
    }
    if (current.counts?.diffs?.[id] !== expectedIds.length) {
      add(errors, `counts.diffs.${id} (${current.counts?.diffs?.[id]}) does not match diff length (${expectedIds.length})`);
    }
  }
  for (const diffId of Object.keys(current.diffs ?? {})) {
    if (!expectedDiffIds.has(diffId)) {
      add(errors, `Unexpected diff definition: ${diffId}`);
    }
  }

  const expectedSegments = Object.fromEntries(SEGMENT_IDS.map((segmentId) => [segmentId, []]));
  for (const game of games) {
    const memberships = Array.isArray(game.memberships) ? game.memberships : [];
    const unknownMemberships = memberships.filter((tierId) => !TIER_IDS.includes(tierId));
    if (unknownMemberships.length > 0) {
      add(errors, `game ${game.id} has unknown tier memberships: ${unknownMemberships.join(', ')}`);
    }
    const expectedMemberships = TIER_IDS.filter((tierId) => tierSets[tierId].has(game.id));
    if (expectedMemberships.length === 0) {
      add(errors, `game ${game.id} is not present in any raw tier list`);
      continue;
    }
    if (!sameSortedValues(memberships, expectedMemberships)) {
      add(errors, `game ${game.id} memberships do not match raw tier lists`);
    }
    const expectedSegmentId = segmentIdForTiers(expectedMemberships);
    if (game.segment !== expectedSegmentId) {
      add(errors, `game ${game.id} segment ${game.segment} does not match memberships (${expectedSegmentId})`);
    }
    expectedSegments[expectedSegmentId].push(game.id);
    const expectedGamePlatforms = new Set();
    for (const tierId of TIER_IDS) {
      const expectedPlatforms = PLATFORM_IDS.filter((platformId) =>
        rawLists[tierId]?.[platformId]?.includes(game.id)
      );
      const actualPlatforms = game.platformByTier?.[tierId] ?? [];
      if (!sameSortedValues(actualPlatforms, expectedPlatforms)) {
        add(errors, `game ${game.id} platformByTier.${tierId} does not match raw tier lists`);
      }
      for (const platformId of expectedPlatforms) {
        expectedGamePlatforms.add(platformId);
      }
    }
    if (!sameSortedValues(game.platforms, [...expectedGamePlatforms])) {
      add(errors, `game ${game.id} platforms do not match tier/platform memberships`);
    }
    for (const [tierId, platforms] of Object.entries(game.platformByTier ?? {})) {
      if (!TIER_IDS.includes(tierId)) {
        add(errors, `game ${game.id} has platform membership for unknown tier ${tierId}`);
        continue;
      }
      for (const platformId of platforms ?? []) {
        if (!PLATFORM_IDS.includes(platformId)) {
          add(errors, `game ${game.id} has unknown platform ${platformId} for tier ${tierId}`);
        } else if (!tierSupportsPlatform(tierId, platformId)) {
          add(errors, `game ${game.id} has unsupported ${tierId}/${platformId} membership`);
        }
      }
    }
  }
  for (const segmentId of SEGMENT_IDS) {
    const expectedIds = expectedSegments[segmentId];
    const actualIds = current.segments?.[segmentId] ?? [];
    if (!sameSortedValues(actualIds, expectedIds)) {
      add(errors, `segments.${segmentId} does not match game memberships`);
    }
    if (current.counts?.segments?.[segmentId] !== expectedIds.length) {
      add(errors, `counts.segments.${segmentId} (${current.counts?.segments?.[segmentId]}) does not match segment length (${expectedIds.length})`);
    }
  }
  for (const segmentId of Object.keys(current.segments ?? {})) {
    if (!SEGMENT_IDS.includes(segmentId)) {
      add(errors, `Unexpected segment definition: ${segmentId}`);
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

function validateFamilies(current, errors) {
  const games = Array.isArray(current.games) ? current.games : [];
  const families = Array.isArray(current.families) ? current.families : [];
  const expected = buildFamilyCatalog(games);
  const expectedFamilies = expected.families;
  const includeScreenshots = games.every((game) => 'screenshots' in game);
  const comparable = (family) => {
    const value = { ...family };
    if (!includeScreenshots) delete value.screenshots;
    return value;
  };
  if (stableStringify(families.map(comparable)) !== stableStringify(expectedFamilies.map(comparable))) {
    add(errors, 'current.families does not match deterministic family grouping');
  }
  if (current.familyHash !== expected.familyHash) {
    add(errors, 'current.familyHash does not match deterministic family membership');
  }
  if (current.familyCounts?.total !== expectedFamilies.length) {
    add(errors, `familyCounts.total (${current.familyCounts?.total}) does not match families length (${expectedFamilies.length})`);
  }

  for (const [label, actual, expectedValue] of [
    ['familyCounts', current.familyCounts, expected.familyCounts],
    ['familySegments', current.familySegments, expected.familySegments],
    ['familyDiffs', current.familyDiffs, expected.familyDiffs]
  ]) {
    if (stableStringify(actual) !== stableStringify(expectedValue)) {
      add(errors, `${label} does not match deterministic family grouping`);
    }
  }

  const grouping = current.metadata?.familyGrouping;
  if (grouping?.schemaVersion !== GAME_FAMILY_SCHEMA_VERSION) {
    add(errors, `metadata.familyGrouping.schemaVersion must be ${GAME_FAMILY_SCHEMA_VERSION}`);
  }
  if (grouping?.productCount !== games.length
    || grouping?.familyCount !== expectedFamilies.length
    || grouping?.collapsedProductCount !== games.length - expectedFamilies.length) {
    add(errors, 'metadata.familyGrouping counts do not match catalog data');
  }
}

function validateGameMetadata(current, errors) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const collections = [
    ['game', Array.isArray(current.games) ? current.games : []],
    ['family', Array.isArray(current.families) ? current.families : []]
  ];
  for (const [kind, items] of collections) {
    for (const game of items) {
      for (const field of ['availableInFR', 'supportsSinglePlayer', 'supportsMultiplayer', 'supportsOnlineMultiplayer', 'supportsLocalMultiplayer', 'supportsCoop', 'supportsOnlineCoop', 'supportsLocalCoop']) {
        if (field in game && typeof game[field] !== 'boolean') {
          add(errors, `${kind} ${game.id} has invalid ${field}: expected boolean`);
        }
      }
      if ('playerModes' in game && (!Array.isArray(game.playerModes) || game.playerModes.some((mode) => typeof mode !== 'string'))) {
        add(errors, `${kind} ${game.id} has invalid playerModes: expected string array`);
      }
      if ('screenshots' in game) {
        if (!Array.isArray(game.screenshots)) {
          add(errors, `${kind} ${game.id} has invalid screenshots: expected string array`);
        } else {
          if (game.screenshots.length > MAX_GAME_SCREENSHOTS) {
            add(errors, `${kind} ${game.id} has invalid screenshots: expected at most ${MAX_GAME_SCREENSHOTS}`);
          }
          const uniqueScreenshots = new Set();
          for (const screenshot of game.screenshots) {
            if (typeof screenshot !== 'string') {
              add(errors, `${kind} ${game.id} has invalid screenshot: expected absolute HTTPS URL`);
              continue;
            }
            let url;
            try {
              url = new URL(screenshot);
            } catch {
              add(errors, `${kind} ${game.id} has invalid screenshot URL: ${screenshot}`);
              continue;
            }
            if (url.protocol !== 'https:') {
              add(errors, `${kind} ${game.id} has invalid screenshot URL protocol: ${screenshot}`);
            }
            if (uniqueScreenshots.has(url.href)) {
              add(errors, `${kind} ${game.id} has duplicate screenshot URL: ${screenshot}`);
            }
            uniqueScreenshots.add(url.href);
          }
        }
      }
      for (const field of ['shortDescription']) {
        if (field in game && typeof game[field] !== 'string') {
          add(errors, `${kind} ${game.id} has invalid ${field}: expected string`);
        }
      }
      if (game.pegiRating != null && typeof game.pegiRating !== 'string') {
        add(errors, `${kind} ${game.id} has invalid pegiRating: expected string or null`);
      }
      if (game.releaseDate != null && (typeof game.releaseDate !== 'string' || !datePattern.test(game.releaseDate))) {
        add(errors, `${kind} ${game.id} has invalid releaseDate: expected YYYY-MM-DD or null`);
      }
    }
  }
}

function validateFamilyReferences(current, errors) {
  const gameIds = new Set((current.games ?? []).map((game) => game.id));
  const seenVariantIds = new Set();
  for (const family of current.families ?? []) {
    if (!Array.isArray(family.variantIds) || family.variantIds.length === 0) {
      add(errors, `family ${family.id} must reference at least one variant`);
      continue;
    }
    for (const variantId of family.variantIds) {
      if (!gameIds.has(variantId)) {
        add(errors, `family ${family.id} references missing game ${variantId}`);
      }
      if (seenVariantIds.has(variantId)) {
        add(errors, `game ${variantId} belongs to more than one family`);
      }
      seenVariantIds.add(variantId);
    }
  }
  for (const gameId of gameIds) {
    if (!seenVariantIds.has(gameId)) {
      add(errors, `game ${gameId} does not belong to a family`);
    }
  }
}

function validateWarnings(current, previousCurrent, warnings) {
  for (const { diffId } of EXPECTED_SUBSET_DEFS) {
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

function validateHistory(history, current, errors) {
  if (!history) {
    return;
  }
  if (history.schemaVersion !== HISTORY_SCHEMA_VERSION) {
    add(errors, `history schema version must be ${HISTORY_SCHEMA_VERSION}, found ${history.schemaVersion ?? 'missing'}`);
  }
  if (!sameSortedValues(history.trackedTiers, TIER_IDS)) {
    add(errors, `history trackedTiers must match configured tiers: ${TIER_IDS.join(', ')}`);
  }
  for (const tierId of TIER_IDS) {
    if (!history.tierBaselines?.[tierId]) {
      add(errors, `history is missing tier baseline for ${tierId}`);
    }
  }
  for (const migration of history.migrations ?? []) {
    if (migration.type !== 'tier_baseline') {
      add(errors, `history has unknown migration type: ${migration.type}`);
    }
    for (const tierId of migration.tierIds ?? []) {
      if (!TIER_IDS.includes(tierId)) {
        add(errors, `history migration references unknown tier ${tierId}`);
      }
    }
  }
  const knownIds = new Set(Object.keys(history.games ?? {}));
  for (const event of history.events ?? []) {
    if (!knownIds.has(event.productId)) {
      add(errors, `history event ${event.id ?? '(no id)'} references unknown product ${event.productId}`);
    }
    if (event.tier && !TIER_IDS.includes(event.tier)) {
      add(errors, `history event ${event.id ?? '(no id)'} references unknown tier ${event.tier}`);
    }
    if (event.platform && !PLATFORM_IDS.includes(event.platform)) {
      add(errors, `history event ${event.id ?? '(no id)'} references unknown platform ${event.platform}`);
    }
  }
  if (history.familySchemaVersion !== GAME_FAMILY_SCHEMA_VERSION) {
    add(errors, `history.familySchemaVersion must be ${GAME_FAMILY_SCHEMA_VERSION}`);
  }
  const knownFamilyIds = new Set(Object.keys(history.families ?? {}));
  for (const event of history.familyEvents ?? []) {
    if (!knownFamilyIds.has(event.familyId)) {
      add(errors, `family history event ${event.id ?? '(no id)'} references unknown family ${event.familyId}`);
    }
    for (const variantId of event.variantIds ?? []) {
      if (!knownIds.has(variantId)) {
        add(errors, `family history event ${event.id ?? '(no id)'} references unknown product ${variantId}`);
      }
    }
  }
  const currentFamilies = new Map((current.families ?? []).map((family) => [family.id, family]));
  for (const [familyId, record] of Object.entries(history.families ?? {})) {
    for (const variantId of record.allVariantIds ?? record.variantIds ?? []) {
      if (!knownIds.has(variantId)) {
        add(errors, `history family ${familyId} references unknown product ${variantId}`);
      }
    }
    if (!record.active) continue;
    const family = currentFamilies.get(familyId);
    if (!family) {
      add(errors, `active history family ${familyId} is missing from current catalog`);
      continue;
    }
    if (stableStringify(record.variantIds ?? []) !== stableStringify(family.variantIds)) {
      add(errors, `history family ${familyId} variants do not match current catalog`);
    }
    if (stableStringify(record.platformByTier ?? {}) !== stableStringify(family.platformByTier)) {
      add(errors, `history family ${familyId} membership does not match current catalog`);
    }
  }
  for (const familyId of currentFamilies.keys()) {
    if (!history.families?.[familyId]?.active) {
      add(errors, `current family ${familyId} is not active in history`);
    }
  }
  for (const observation of history.observations ?? []) {
    if (typeof observation.familyChanged !== 'boolean' || typeof observation.productChanged !== 'boolean') {
      add(errors, `history observation ${observation.generatedAt} is missing dual change flags`);
    }
    if (observation.total !== observation.familyTotal) {
      add(errors, `history observation ${observation.generatedAt} total does not match family total`);
    }
    if (observation.familyCounts?.total !== observation.familyTotal) {
      add(errors, `history observation ${observation.generatedAt} family counts do not match family total`);
    }
    if (observation.productCounts?.total !== observation.productTotal) {
      add(errors, `history observation ${observation.generatedAt} product counts do not match product total`);
    }
  }
  const latestObservation = (history.observations ?? []).at(-1);
  if (latestObservation?.generatedAt === current.generatedAt) {
    if (latestObservation.familyTotal !== current.familyCounts?.total) {
      add(errors, 'latest history observation family total does not match current catalog');
    }
    if (latestObservation.productTotal !== current.counts?.total) {
      add(errors, 'latest history observation product total does not match current catalog');
    }
  }
  for (const snapshot of history.snapshots ?? []) {
    if (!snapshot.path?.startsWith('snapshots/')) {
      add(errors, `history snapshot has invalid path: ${snapshot.path}`);
    }
    if (snapshot.total !== snapshot.familyTotal) {
      add(errors, `history snapshot ${snapshot.path} total does not match family total`);
    }
    if (snapshot.familyCounts?.total !== snapshot.familyTotal) {
      add(errors, `history snapshot ${snapshot.path} family counts do not match family total`);
    }
    if (snapshot.productCounts?.total !== snapshot.productTotal) {
      add(errors, `history snapshot ${snapshot.path} product counts do not match product total`);
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
  validateLabels(current, errors);
  validateSources(current, errors);
  validateCounts(current, errors);
  validateFamilyReferences(current, errors);
  validateFamilies(current, errors);
  validateGameMetadata(current, errors);
  validateWarnings(current, previousCurrent, warnings);
  validateHistory(history, current, errors);
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
