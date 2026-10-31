import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GENERATED_PATHS,
  HISTORY_SCHEMA_VERSION,
  PLATFORM_IDS,
  TIER_IDS,
  hashObject,
  isMainModule,
  readJsonIfExists,
  stableStringify,
  todayFromIso,
  writeJsonFile
} from './constants.mjs';
import {
  GAME_FAMILY_SCHEMA_VERSION,
  buildFamilyCatalog,
  buildMembershipSummary
} from './game-families.mjs';

const LEGACY_TRACKED_TIER_IDS = ['ultimate', 'premium', 'essential'];

function membershipSignature(game) {
  return TIER_IDS.flatMap((tierId) =>
    (game.platformByTier?.[tierId] ?? []).map((platformId) => `${tierId}:${platformId}`)
  ).sort();
}

function membershipsEqual(left, right) {
  const leftSignature = membershipSignature(left);
  const rightSignature = membershipSignature(right);
  return leftSignature.length === rightSignature.length && leftSignature.every((value, index) => value === rightSignature[index]);
}

function gameSnapshot(game) {
  return {
    id: game.id,
    title: game.title,
    memberships: game.memberships,
    platformByTier: game.platformByTier,
    platforms: game.platforms,
    segment: game.segment,
    url: game.url ?? null
  };
}

function gamesById(current) {
  return Object.fromEntries(current.games.map((game) => [game.id, game]));
}

function familySnapshot(family) {
  return {
    id: family.id,
    familyKey: family.familyKey,
    familySchemaVersion: family.familySchemaVersion,
    title: family.title,
    variantIds: family.variantIds,
    memberships: family.memberships,
    platformByTier: family.platformByTier,
    platforms: family.platforms,
    segment: family.segment
  };
}

function eventCounts(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function emptyHistory(current, generatedAt) {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    generatedAt,
    market: current.market,
    language: current.language,
    baselineAt: generatedAt,
    trackedTiers: [...TIER_IDS],
    tierBaselines: Object.fromEntries(TIER_IDS.map((tierId) => [tierId, generatedAt])),
    lastObservedAt: generatedAt,
    lastChangedAt: null,
    catalogHash: current.catalogHash,
    familyHash: current.familyHash,
    familySchemaVersion: GAME_FAMILY_SCHEMA_VERSION,
    games: {},
    families: {},
    events: [],
    familyEvents: [],
    observations: [],
    snapshots: []
  };
}

function createGameRecord(game, generatedAt, source) {
  const baseline = source === 'baseline' || source === 'tier_baseline';
  const tierFirstObservedAt = Object.fromEntries(game.memberships.map((tierId) => [tierId, generatedAt]));
  const platformFirstObservedAt = Object.fromEntries(game.platforms.map((platformId) => [platformId, generatedAt]));
  const tierPlatformFirstObservedAt = Object.fromEntries(
    Object.entries(game.platformByTier).flatMap(([tierId, platforms]) =>
      platforms.map((platformId) => [`${tierId}:${platformId}`, generatedAt])
    )
  );
  return {
    id: game.id,
    title: game.title,
    firstObservedAt: generatedAt,
    firstObservedSource: source,
    addedAt: baseline ? null : generatedAt,
    lastObservedAt: generatedAt,
    removedAt: null,
    readdedAt: null,
    active: true,
    baseline,
    memberships: game.memberships,
    platformByTier: game.platformByTier,
    platforms: game.platforms,
    segment: game.segment,
    tierFirstObservedAt,
    platformFirstObservedAt,
    tierPlatformFirstObservedAt,
    lastTierChangedAt: null,
    lastPlatformChangedAt: null,
    url: game.url ?? null
  };
}

function updateGameRecord(record, game, generatedAt) {
  record.title = game.title;
  record.lastObservedAt = generatedAt;
  record.removedAt = null;
  record.active = true;
  record.memberships = game.memberships;
  record.platformByTier = game.platformByTier;
  record.platforms = game.platforms;
  record.segment = game.segment;
  record.url = game.url ?? record.url ?? null;
  record.tierFirstObservedAt ??= {};
  record.platformFirstObservedAt ??= {};
  record.tierPlatformFirstObservedAt ??= {};
  for (const tierId of game.memberships) {
    record.tierFirstObservedAt[tierId] ??= generatedAt;
  }
  for (const platformId of game.platforms) {
    record.platformFirstObservedAt[platformId] ??= generatedAt;
  }
  for (const [tierId, platforms] of Object.entries(game.platformByTier)) {
    for (const platformId of platforms) {
      record.tierPlatformFirstObservedAt[`${tierId}:${platformId}`] ??= generatedAt;
    }
  }
}

function createFamilyRecord(family, generatedAt, source) {
  const record = createGameRecord(family, generatedAt, source);
  delete record.url;
  return {
    ...record,
    familyKey: family.familyKey,
    familySchemaVersion: family.familySchemaVersion,
    variantIds: [...family.variantIds],
    allVariantIds: [...family.variantIds]
  };
}

function updateFamilyRecord(record, family, generatedAt) {
  updateGameRecord(record, family, generatedAt);
  delete record.url;
  record.familyKey = family.familyKey;
  record.familySchemaVersion = family.familySchemaVersion;
  record.variantIds = [...family.variantIds];
  record.allVariantIds = [...new Set([...(record.allVariantIds ?? []), ...family.variantIds])].sort();
}

function trackedTiersBeforeMigration(history) {
  if (Array.isArray(history.trackedTiers)) {
    return history.trackedTiers.filter((tierId) => TIER_IDS.includes(tierId));
  }
  return LEGACY_TRACKED_TIER_IDS.filter((tierId) => TIER_IDS.includes(tierId));
}

function baselineTierMemberships({
  records,
  items,
  previouslyTrackedTiers,
  addedTierIds,
  generatedAt
}) {
  const addedTierSet = new Set(addedTierIds);
  const baselineIds = new Set();
  let itemCount = 0;
  let newItemCount = 0;

  for (const item of items) {
    const addedMemberships = item.memberships.filter((tierId) => addedTierSet.has(tierId));
    if (addedMemberships.length === 0) {
      continue;
    }
    itemCount += 1;
    const record = records[item.id];
    const hasPreviouslyTrackedMembership = item.memberships.some((tierId) =>
      previouslyTrackedTiers.includes(tierId)
    );
    if (!record) {
      if (!hasPreviouslyTrackedMembership) {
        baselineIds.add(item.id);
        newItemCount += 1;
      }
      continue;
    }
    const baselineOnlyReactivation = !record.active && !hasPreviouslyTrackedMembership;

    record.memberships ??= [];
    record.platformByTier ??= {};
    record.tierFirstObservedAt ??= {};
    record.platformFirstObservedAt ??= {};
    record.tierPlatformFirstObservedAt ??= {};
    for (const tierId of addedMemberships) {
      if (!record.memberships.includes(tierId)) {
        record.memberships.push(tierId);
      }
      const platforms = [...(item.platformByTier?.[tierId] ?? [])];
      record.platformByTier[tierId] = platforms;
      record.tierFirstObservedAt[tierId] ??= generatedAt;
      for (const platformId of platforms) {
        record.platformFirstObservedAt[platformId] ??= generatedAt;
        record.tierPlatformFirstObservedAt[`${tierId}:${platformId}`] ??= generatedAt;
      }
    }
    if (baselineOnlyReactivation) {
      record.memberships = [...item.memberships];
      record.platformByTier = Object.fromEntries(
        Object.entries(item.platformByTier).map(([tierId, platforms]) => [tierId, [...platforms]])
      );
    } else {
      record.memberships = TIER_IDS.filter((tierId) => record.memberships.includes(tierId));
    }
    record.platforms = PLATFORM_IDS.filter((platformId) =>
      Object.values(record.platformByTier).some((platforms) => platforms.includes(platformId))
    );
    record.segment = item.segment;
    if (baselineOnlyReactivation) {
      record.active = true;
      record.removedAt = null;
    }
  }

  return { baselineIds, itemCount, newItemCount };
}

function prepareTierBaselineMigration({ history, current, generatedAt }) {
  const previouslyTrackedTiers = trackedTiersBeforeMigration(history);
  const addedTierIds = TIER_IDS.filter((tierId) => !previouslyTrackedTiers.includes(tierId));

  history.schemaVersion = HISTORY_SCHEMA_VERSION;
  history.tierBaselines ??= {};
  for (const tierId of previouslyTrackedTiers) {
    history.tierBaselines[tierId] ??= history.baselineAt ?? generatedAt;
  }

  if (addedTierIds.length === 0) {
    history.trackedTiers = [...TIER_IDS];
    return {
      migration: null,
      baselineProductIds: new Set(),
      baselineFamilyIds: new Set()
    };
  }

  const productBaseline = baselineTierMemberships({
    records: history.games,
    items: current.games,
    previouslyTrackedTiers,
    addedTierIds,
    generatedAt
  });
  const familyBaseline = baselineTierMemberships({
    records: history.families,
    items: current.families,
    previouslyTrackedTiers,
    addedTierIds,
    generatedAt
  });

  for (const tierId of addedTierIds) {
    history.tierBaselines[tierId] = generatedAt;
  }
  history.trackedTiers = [...TIER_IDS];
  const migration = {
    type: 'tier_baseline',
    generatedAt,
    tierIds: addedTierIds,
    productCount: productBaseline.itemCount,
    newProductCount: productBaseline.newItemCount
  };
  history.migrations = [...(history.migrations ?? []), migration];
  return {
    migration,
    baselineProductIds: productBaseline.baselineIds,
    baselineFamilyIds: familyBaseline.baselineIds
  };
}

function createEvent({ generatedAt, type, game, tier = null, platform = null, previous = null, current = null }) {
  return {
    id: `${generatedAt}:${type}:${game.id}:${tier ?? ''}:${platform ?? ''}`,
    date: todayFromIso(generatedAt),
    generatedAt,
    type,
    productId: game.id,
    title: game.title,
    tier,
    platform,
    previous,
    current
  };
}

function createFamilyEvent({ generatedAt, type, family, tier = null, platform = null, previous = null, current = null }) {
  return {
    id: `${generatedAt}:${type}:${family.id}:${tier ?? ''}:${platform ?? ''}`,
    date: todayFromIso(generatedAt),
    generatedAt,
    type,
    familyId: family.id,
    title: family.title,
    variantIds: [...(family.variantIds ?? [])],
    tier,
    platform,
    previous,
    current
  };
}

function compareMemberships({ oldGame, newGame, generatedAt }) {
  const events = [];
  for (const tierId of TIER_IDS) {
    const oldHasTier = oldGame.memberships.includes(tierId);
    const newHasTier = newGame.memberships.includes(tierId);
    if (!oldHasTier && newHasTier) {
      events.push(createEvent({ generatedAt, type: 'tier_added', game: newGame, tier: tierId }));
    } else if (oldHasTier && !newHasTier) {
      events.push(createEvent({ generatedAt, type: 'tier_removed', game: newGame, tier: tierId }));
    }

    for (const platformId of PLATFORM_IDS) {
      const oldHasPlatform = oldGame.platformByTier?.[tierId]?.includes(platformId) ?? false;
      const newHasPlatform = newGame.platformByTier?.[tierId]?.includes(platformId) ?? false;
      if (!oldHasPlatform && newHasPlatform) {
        events.push(createEvent({ generatedAt, type: 'platform_added', game: newGame, tier: tierId, platform: platformId }));
      } else if (oldHasPlatform && !newHasPlatform) {
        events.push(createEvent({ generatedAt, type: 'platform_removed', game: newGame, tier: tierId, platform: platformId }));
      }
    }
  }
  return events;
}

function compareFamilyMemberships({ oldFamily, newFamily, generatedAt }) {
  const events = [];
  for (const tierId of TIER_IDS) {
    const oldHasTier = oldFamily.memberships.includes(tierId);
    const newHasTier = newFamily.memberships.includes(tierId);
    if (!oldHasTier && newHasTier) {
      events.push(createFamilyEvent({ generatedAt, type: 'tier_added', family: newFamily, tier: tierId }));
    } else if (oldHasTier && !newHasTier) {
      events.push(createFamilyEvent({ generatedAt, type: 'tier_removed', family: newFamily, tier: tierId }));
    }

    for (const platformId of PLATFORM_IDS) {
      const oldHasPlatform = oldFamily.platformByTier?.[tierId]?.includes(platformId) ?? false;
      const newHasPlatform = newFamily.platformByTier?.[tierId]?.includes(platformId) ?? false;
      if (!oldHasPlatform && newHasPlatform) {
        events.push(createFamilyEvent({
          generatedAt,
          type: 'platform_added',
          family: newFamily,
          tier: tierId,
          platform: platformId
        }));
      } else if (oldHasPlatform && !newHasPlatform) {
        events.push(createFamilyEvent({
          generatedAt,
          type: 'platform_removed',
          family: newFamily,
          tier: tierId,
          platform: platformId
        }));
      }
    }
  }
  return events;
}

function familyFromRecord(record) {
  return {
    id: record.id,
    familyKey: record.familyKey,
    familySchemaVersion: record.familySchemaVersion,
    title: record.title,
    variantIds: record.variantIds ?? [],
    memberships: record.memberships ?? [],
    platformByTier: record.platformByTier ?? {},
    platforms: record.platforms ?? [],
    segment: record.segment ?? null
  };
}

function updateFamilyRecords({ records, families, generatedAt, source = 'observed', baselineIds = new Set() }) {
  const currentFamilies = Object.fromEntries(families.map((family) => [family.id, family]));
  const events = [];
  for (const [familyId, record] of Object.entries(records)) {
    if (record.active && !currentFamilies[familyId]) {
      record.active = false;
      record.removedAt = generatedAt;
      events.push(createFamilyEvent({ generatedAt, type: 'removed', family: familyFromRecord(record) }));
    }
  }
  for (const family of families) {
    const record = records[family.id];
    if (!record) {
      const recordSource = baselineIds.has(family.id) ? 'tier_baseline' : source;
      records[family.id] = createFamilyRecord(family, generatedAt, recordSource);
      if (recordSource === 'observed') {
        events.push(createFamilyEvent({ generatedAt, type: 'added', family }));
      }
      continue;
    }
    if (!record.active) {
      record.active = true;
      record.readdedAt = generatedAt;
      record.removedAt = null;
      events.push(createFamilyEvent({ generatedAt, type: 'readded', family }));
    }
    const oldFamily = familyFromRecord(record);
    if (!membershipsEqual(oldFamily, family)) {
      const membershipEvents = compareFamilyMemberships({ oldFamily, newFamily: family, generatedAt });
      for (const event of membershipEvents) {
        if (event.type.startsWith('tier_')) record.lastTierChangedAt = generatedAt;
        if (event.type.startsWith('platform_')) record.lastPlatformChangedAt = generatedAt;
      }
      events.push(...membershipEvents);
    }
    updateFamilyRecord(record, family, generatedAt);
  }
  return events;
}

function catalogForSnapshot(snapshot) {
  const derived = buildFamilyCatalog(snapshot.games ?? []);
  const snapshotFamilyVersion = snapshot.familySchemaVersion
    ?? snapshot.families?.[0]?.familySchemaVersion;
  const useSnapshotFamilies = snapshotFamilyVersion === GAME_FAMILY_SCHEMA_VERSION
    && Array.isArray(snapshot.families);
  return {
    families: useSnapshotFamilies ? snapshot.families : derived.families,
    familyHash: useSnapshotFamilies ? snapshot.familyHash ?? derived.familyHash : derived.familyHash,
    familyCounts: useSnapshotFamilies ? snapshot.familyCounts ?? derived.familyCounts : derived.familyCounts
  };
}

function seedFamilyHistoryFromProducts(history) {
  const activeGames = Object.values(history.games ?? {})
    .filter((record) => record.active)
    .map((record) => ({
      id: record.id,
      title: record.title,
      memberships: record.memberships ?? [],
      platformByTier: record.platformByTier ?? {},
      platforms: record.platforms ?? [],
      segment: record.segment ?? null,
      url: record.url ?? null
    }));
  const catalog = buildFamilyCatalog(activeGames);
  const activeProductCounts = buildMembershipSummary(activeGames).counts;
  const generatedAt = history.lastObservedAt ?? history.generatedAt ?? history.baselineAt;
  history.families = {};
  updateFamilyRecords({
    records: history.families,
    families: catalog.families,
    generatedAt,
    source: 'baseline'
  });
  history.familyEvents = [];
  history.familyHash = catalog.familyHash;
  history.familySchemaVersion = GAME_FAMILY_SCHEMA_VERSION;
  history.familyHistorySource = 'legacy-active-products';
  for (const observation of history.observations ?? []) {
    observation.productTotal ??= observation.total;
    observation.productCounts ??= observation.counts;
    observation.productEventCounts ??= observation.eventCounts ?? {};
    observation.total = catalog.familyCounts.total;
    observation.counts = catalog.familyCounts;
    observation.eventCounts = {};
    observation.familyTotal = catalog.familyCounts.total;
    observation.familyCounts = catalog.familyCounts;
    observation.familyEventCounts = {};
    observation.familyHash = catalog.familyHash;
    observation.familyChanged = observation.baseline === true;
    observation.productChanged ??= observation.baseline === true
      || Object.values(observation.productEventCounts).some((count) => Number(count) > 0);
  }
  for (const snapshotEntry of history.snapshots ?? []) {
    snapshotEntry.productTotal ??= snapshotEntry.total ?? activeGames.length;
    const observation = (history.observations ?? []).find((item) =>
      item.generatedAt === snapshotEntry.generatedAt
    );
    snapshotEntry.productCounts ??= observation?.productCounts ?? activeProductCounts;
    snapshotEntry.total = catalog.familyCounts.total;
    snapshotEntry.familyTotal = catalog.familyCounts.total;
    snapshotEntry.familyHash = catalog.familyHash;
    snapshotEntry.familyCounts = catalog.familyCounts;
  }
}

export async function readHistorySnapshots(history, baseDir = GENERATED_PATHS.siteDataDir) {
  return Promise.all(
    (history?.snapshots ?? []).map(async (entry) =>
      JSON.parse(await readFile(join(baseDir, entry.path), 'utf8'))
    )
  );
}

export function backfillFamilyHistory({ history, snapshots = [] }) {
  const snapshotEntriesAreDual = (history.snapshots ?? []).every((entry) =>
    entry.familyTotal != null
    && entry.productTotal != null
    && entry.familyCounts
    && entry.productCounts
  );
  const observationsAreDual = (history.observations ?? []).every((observation) =>
    observation.familyChanged != null
    && observation.productChanged != null
    && observation.familyTotal != null
    && observation.productTotal != null
    && observation.familyCounts
    && observation.productCounts
    && observation.familyEventCounts
    && observation.productEventCounts
  );
  if (history.familySchemaVersion === GAME_FAMILY_SCHEMA_VERSION
    && history.families
    && history.familyEvents
    && snapshotEntriesAreDual
    && observationsAreDual) {
    return history;
  }

  const orderedSnapshots = snapshots
    .filter((snapshot) => snapshot?.generatedAt && Array.isArray(snapshot.games))
    .sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
  if (orderedSnapshots.length === 0) {
    seedFamilyHistoryFromProducts(history);
    return history;
  }

  history.families = {};
  history.familyEvents = [];
  const productStates = new Map((history.observations ?? []).map((observation) => [
    observation.generatedAt,
    {
      productTotal: observation.productTotal ?? observation.total,
      productCounts: observation.productCounts ?? observation.counts
    }
  ]));
  const states = [];
  for (const [index, snapshot] of orderedSnapshots.entries()) {
    const catalog = catalogForSnapshot(snapshot);
    const productState = productStates.get(snapshot.generatedAt);
    const productCounts = snapshot.productCounts
      ?? productState?.productCounts
      ?? buildMembershipSummary(snapshot.games).counts;
    const snapshotEntry = (history.snapshots ?? []).find((entry) =>
      entry.generatedAt === snapshot.generatedAt
    );
    const observation = (history.observations ?? []).find((item) =>
      item.generatedAt === snapshot.generatedAt
    );
    const migration = snapshot.migration ?? snapshotEntry?.migration ?? observation?.migration;
    const addedTierIds = migration?.type === 'tier_baseline'
      ? (migration.tierIds ?? []).filter((tierId) => TIER_IDS.includes(tierId))
      : [];
    const familyBaseline = index > 0 && addedTierIds.length > 0
      ? baselineTierMemberships({
          records: history.families,
          items: catalog.families,
          previouslyTrackedTiers: TIER_IDS.filter((tierId) => !addedTierIds.includes(tierId)),
          addedTierIds,
          generatedAt: snapshot.generatedAt
        })
      : { baselineIds: new Set() };
    const events = updateFamilyRecords({
      records: history.families,
      families: catalog.families,
      generatedAt: snapshot.generatedAt,
      source: index === 0 ? 'baseline' : 'observed',
      baselineIds: familyBaseline.baselineIds
    });
    history.familyEvents.push(...events);
    states.push({
      generatedAt: snapshot.generatedAt,
      familyHash: catalog.familyHash,
      familyCounts: catalog.familyCounts,
      productTotal: snapshot.productTotal ?? productState?.productTotal ?? snapshot.games.length,
      productCounts
    });
  }

  const familyEventsByObservation = new Map();
  for (const event of history.familyEvents) {
    if (!familyEventsByObservation.has(event.generatedAt)) {
      familyEventsByObservation.set(event.generatedAt, []);
    }
    familyEventsByObservation.get(event.generatedAt).push(event);
  }
  for (const observation of history.observations ?? []) {
    const state = states.findLast((item) => item.generatedAt <= observation.generatedAt);
    if (!state) continue;
    const familyEvents = familyEventsByObservation.get(observation.generatedAt) ?? [];
    observation.productTotal ??= observation.total;
    observation.productCounts ??= observation.counts;
    observation.productEventCounts ??= observation.eventCounts ?? {};
    observation.total = state.familyCounts.total;
    observation.counts = state.familyCounts;
    observation.eventCounts = eventCounts(familyEvents);
    observation.familyTotal = state.familyCounts.total;
    observation.familyCounts = state.familyCounts;
    observation.familyEventCounts = eventCounts(familyEvents);
    observation.familyHash = state.familyHash;
    observation.familyChanged = observation.baseline === true || familyEvents.length > 0;
    observation.productChanged = observation.baseline === true
      || Object.values(observation.productEventCounts).some((count) => Number(count) > 0);
  }
  for (const snapshotEntry of history.snapshots ?? []) {
    const state = states.find((item) => item.generatedAt === snapshotEntry.generatedAt);
    if (!state) continue;
    snapshotEntry.total = state.familyCounts.total;
    snapshotEntry.familyTotal = state.familyCounts.total;
    snapshotEntry.productTotal = state.productTotal;
    snapshotEntry.familyHash = state.familyHash;
    snapshotEntry.familyCounts = state.familyCounts;
    snapshotEntry.productCounts = state.productCounts;
  }

  history.familyHash = states.at(-1)?.familyHash ?? null;
  history.familySchemaVersion = GAME_FAMILY_SCHEMA_VERSION;
  history.familyHistorySource = 'snapshots';
  history.lastFamilyChangedAt = history.familyEvents.at(-1)?.generatedAt ?? null;
  return history;
}

function observationFor({ current, generatedAt, productEvents, familyEvents, baseline, migration }) {
  const familyCounts = current.familyCounts;
  const productsChanged = productEvents.length > 0;
  const familiesChanged = familyEvents.length > 0;
  return {
    generatedAt,
    date: todayFromIso(generatedAt),
    catalogHash: current.catalogHash,
    familyHash: current.familyHash,
    familySchemaVersion: GAME_FAMILY_SCHEMA_VERSION,
    changed: baseline || migration !== null || productsChanged || familiesChanged,
    familyChanged: baseline || familiesChanged,
    productChanged: baseline || productsChanged,
    baseline,
    total: familyCounts.total,
    counts: familyCounts,
    eventCounts: eventCounts(familyEvents),
    familyTotal: familyCounts.total,
    familyCounts,
    familyEventCounts: eventCounts(familyEvents),
    productTotal: current.counts.total,
    productCounts: current.counts,
    productEventCounts: eventCounts(productEvents),
    ...(migration ? { migration } : {})
  };
}

export function membershipOnlySnapshot(current, generatedAt) {
  return {
    generatedAt,
    date: todayFromIso(generatedAt),
    catalogHash: current.catalogHash,
    familyHash: current.familyHash,
    market: current.market,
    language: current.language,
    productTotal: current.counts.total,
    familyTotal: current.familyCounts.total,
    productCounts: current.counts,
    familyCounts: current.familyCounts,
    games: current.games.map(gameSnapshot),
    families: current.families.map(familySnapshot)
  };
}

export function updateHistory({
  previousHistory = null,
  previousSnapshots = [],
  current,
  generatedAt = current.generatedAt ?? new Date().toISOString()
}) {
  const history = previousHistory && Object.keys(previousHistory.games ?? {}).length > 0
    ? structuredClone(previousHistory)
    : emptyHistory(current, generatedAt);
  const currentGames = gamesById(current);
  const previousRecords = history.games ?? {};
  const baseline = !previousHistory || Object.keys(previousRecords).length === 0;
  const productEvents = [];
  if (!baseline) {
    backfillFamilyHistory({ history, snapshots: previousSnapshots });
  }
  history.families ??= {};
  history.familyEvents ??= [];
  const existingObservation = (history.observations ?? []).find((item) =>
    item.generatedAt === generatedAt
  );
  const observationBaseline = baseline || existingObservation?.baseline === true;
  const tierBaseline = baseline
    ? {
        migration: null,
        baselineProductIds: new Set(),
        baselineFamilyIds: new Set()
      }
    : prepareTierBaselineMigration({ history, current, generatedAt });
  const { baselineProductIds, baselineFamilyIds } = tierBaseline;
  const migration = tierBaseline.migration
    ?? existingObservation?.migration
    ?? (history.migrations ?? []).find((item) => item.generatedAt === generatedAt)
    ?? null;

  if (baseline) {
    for (const game of current.games) {
      history.games[game.id] = createGameRecord(game, generatedAt, 'baseline');
    }
  } else {
    for (const [productId, record] of Object.entries(previousRecords)) {
      if (record.active && !currentGames[productId]) {
        const oldGame = {
          id: productId,
          title: record.title,
          memberships: record.memberships ?? [],
          platformByTier: record.platformByTier ?? {},
          platforms: record.platforms ?? [],
          segment: record.segment ?? null
        };
        record.active = false;
        record.removedAt = generatedAt;
        productEvents.push(createEvent({ generatedAt, type: 'removed', game: oldGame }));
      }
    }

    for (const game of current.games) {
      const record = previousRecords[game.id];
      if (!record) {
        if (baselineProductIds.has(game.id)) {
          history.games[game.id] = createGameRecord(game, generatedAt, 'tier_baseline');
        } else {
          history.games[game.id] = createGameRecord(game, generatedAt, 'observed');
          productEvents.push(createEvent({ generatedAt, type: 'added', game }));
        }
        continue;
      }
      if (!record.active) {
        record.active = true;
        record.readdedAt = generatedAt;
        record.removedAt = null;
        productEvents.push(createEvent({ generatedAt, type: 'readded', game }));
      }
      const oldGame = {
        id: game.id,
        title: record.title,
        memberships: record.memberships ?? [],
        platformByTier: record.platformByTier ?? {},
        platforms: record.platforms ?? [],
        segment: record.segment ?? null
      };
      if (!membershipsEqual(oldGame, game)) {
        const membershipEvents = compareMemberships({ oldGame, newGame: game, generatedAt });
        for (const event of membershipEvents) {
          if (event.type.startsWith('tier_')) {
            record.lastTierChangedAt = generatedAt;
          }
          if (event.type.startsWith('platform_')) {
            record.lastPlatformChangedAt = generatedAt;
          }
        }
        productEvents.push(...membershipEvents);
      }
      updateGameRecord(record, game, generatedAt);
    }
  }

  const familyEvents = baseline
    ? updateFamilyRecords({
      records: history.families,
      families: current.families,
      generatedAt,
      source: 'baseline'
    })
    : updateFamilyRecords({
      records: history.families,
      families: current.families,
      generatedAt,
      baselineIds: baselineFamilyIds
    });

  history.generatedAt = generatedAt;
  history.lastObservedAt = generatedAt;
  history.catalogHash = current.catalogHash;
  history.familyHash = current.familyHash;
  history.familySchemaVersion = GAME_FAMILY_SCHEMA_VERSION;
  history.schemaVersion = HISTORY_SCHEMA_VERSION;
  history.market = current.market;
  history.language = current.language;
  history.events = [...(history.events ?? []), ...productEvents];
  history.familyEvents = [...(history.familyEvents ?? []), ...familyEvents];
  const observationProductEvents = productEvents.length > 0
    ? productEvents
    : history.events.filter((event) => event.generatedAt === generatedAt);
  const observationFamilyEvents = familyEvents.length > 0
    ? familyEvents
    : history.familyEvents.filter((event) => event.generatedAt === generatedAt);
  const observation = observationFor({
    current,
    generatedAt,
    productEvents: observationProductEvents,
    familyEvents: observationFamilyEvents,
    baseline: observationBaseline,
    migration
  });
  history.observations = [
    ...(history.observations ?? []).filter((item) => item.generatedAt !== generatedAt),
    observation
  ].sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
  const changed = observationBaseline
    || migration !== null
    || observationProductEvents.length > 0
    || observationFamilyEvents.length > 0;
  if (!observationBaseline && changed) {
    history.lastChangedAt = generatedAt;
  }
  if (!observationBaseline && observationFamilyEvents.length > 0) {
    history.lastFamilyChangedAt = generatedAt;
  }

  let snapshot = null;
  if (changed) {
    snapshot = membershipOnlySnapshot(current, generatedAt);
    const shortHash = hashObject(snapshot).slice(0, 8);
    const path = `snapshots/${todayFromIso(generatedAt)}-${shortHash}.json`;
    history.snapshots = [
      ...(history.snapshots ?? []).filter((item) => item.path !== path),
      {
        generatedAt,
        date: todayFromIso(generatedAt),
        catalogHash: current.catalogHash,
        familyHash: current.familyHash,
        path,
        total: current.familyCounts.total,
        familyTotal: current.familyCounts.total,
        productTotal: current.counts.total,
        familyCounts: current.familyCounts,
        productCounts: current.counts,
        changed: true,
        baseline: observationBaseline,
        ...(migration ? { migration } : {})
      }
    ];
  }

  return {
    history,
    events: observationFamilyEvents,
    productEvents: observationProductEvents,
    familyEvents: observationFamilyEvents,
    changed,
    familyChanged: observationBaseline || observationFamilyEvents.length > 0,
    productChanged: observationBaseline || observationProductEvents.length > 0,
    baseline: observationBaseline,
    migration,
    snapshot
  };
}

function parseCliArgs(argv) {
  const args = {
    current: GENERATED_PATHS.current,
    history: GENERATED_PATHS.history,
    out: GENERATED_PATHS.history
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--current') {
      args.current = argv[++index];
    } else if (arg === '--history') {
      args.history = argv[++index];
    } else if (arg === '--out') {
      args.out = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const current = JSON.parse(await readFile(args.current, 'utf8'));
  const previousHistory = await readJsonIfExists(args.history);
  const previousSnapshots = await readHistorySnapshots(previousHistory, dirname(args.history));
  const result = updateHistory({
    current,
    previousHistory,
    previousSnapshots,
    generatedAt: current.generatedAt
  });
  if (args.out === '-') {
    process.stdout.write(stableStringify(result.history));
  } else {
    await writeJsonFile(args.out, result.history);
    if (result.snapshot) {
      const snapshotPath = join(dirname(args.out), result.history.snapshots.at(-1).path);
      await writeJsonFile(snapshotPath, result.snapshot);
    }
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
