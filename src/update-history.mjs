import { readFile } from 'node:fs/promises';
import {
  PLATFORM_IDS,
  TIER_IDS,
  hashObject,
  isMainModule,
  readJsonIfExists,
  stableStringify,
  todayFromIso,
  writeJsonFile
} from './constants.mjs';

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
    segment: game.segment
  };
}

function gamesById(current) {
  return Object.fromEntries(current.games.map((game) => [game.id, game]));
}

function emptyHistory(current, generatedAt) {
  return {
    generatedAt,
    market: current.market,
    language: current.language,
    baselineAt: generatedAt,
    lastObservedAt: generatedAt,
    lastChangedAt: null,
    catalogHash: current.catalogHash,
    games: {},
    events: [],
    observations: [],
    snapshots: []
  };
}

function createGameRecord(game, generatedAt, source) {
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
    addedAt: source === 'baseline' ? null : generatedAt,
    lastObservedAt: generatedAt,
    removedAt: null,
    readdedAt: null,
    active: true,
    baseline: source === 'baseline',
    memberships: game.memberships,
    platformByTier: game.platformByTier,
    platforms: game.platforms,
    segment: game.segment,
    tierFirstObservedAt,
    platformFirstObservedAt,
    tierPlatformFirstObservedAt,
    lastTierChangedAt: null,
    lastPlatformChangedAt: null
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

function observationFor(current, generatedAt, events, baseline) {
  const eventCounts = {};
  for (const event of events) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  }
  return {
    generatedAt,
    date: todayFromIso(generatedAt),
    catalogHash: current.catalogHash,
    changed: baseline || events.length > 0,
    baseline,
    total: current.counts.total,
    counts: current.counts,
    eventCounts
  };
}

export function membershipOnlySnapshot(current, generatedAt) {
  return {
    generatedAt,
    date: todayFromIso(generatedAt),
    catalogHash: current.catalogHash,
    market: current.market,
    language: current.language,
    games: current.games.map(gameSnapshot)
  };
}

export function updateHistory({
  previousHistory = null,
  current,
  generatedAt = current.generatedAt ?? new Date().toISOString()
}) {
  const history = previousHistory && Object.keys(previousHistory.games ?? {}).length > 0
    ? structuredClone(previousHistory)
    : emptyHistory(current, generatedAt);
  const currentGames = gamesById(current);
  const previousRecords = history.games ?? {};
  const baseline = !previousHistory || Object.keys(previousRecords).length === 0;
  const events = [];

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
        events.push(createEvent({ generatedAt, type: 'removed', game: oldGame }));
      }
    }

    for (const game of current.games) {
      const record = previousRecords[game.id];
      if (!record) {
        history.games[game.id] = createGameRecord(game, generatedAt, 'observed');
        events.push(createEvent({ generatedAt, type: 'added', game }));
        continue;
      }
      if (!record.active) {
        record.active = true;
        record.readdedAt = generatedAt;
        record.removedAt = null;
        events.push(createEvent({ generatedAt, type: 'readded', game }));
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
        events.push(...membershipEvents);
      }
      updateGameRecord(record, game, generatedAt);
    }
  }

  history.generatedAt = generatedAt;
  history.lastObservedAt = generatedAt;
  history.catalogHash = current.catalogHash;
  history.market = current.market;
  history.language = current.language;
  history.events = [...(history.events ?? []), ...events];
  history.observations = [...(history.observations ?? []), observationFor(current, generatedAt, events, baseline)];
  if (!baseline && events.length > 0) {
    history.lastChangedAt = generatedAt;
  }

  let snapshot = null;
  if (baseline || events.length > 0) {
    snapshot = membershipOnlySnapshot(current, generatedAt);
    const shortHash = hashObject(snapshot).slice(0, 8);
    const path = `snapshots/${todayFromIso(generatedAt)}-${shortHash}.json`;
    history.snapshots = [
      ...(history.snapshots ?? []).filter((item) => item.path !== path),
      {
        generatedAt,
        date: todayFromIso(generatedAt),
        catalogHash: current.catalogHash,
        path,
        total: current.counts.total,
        changed: true,
        baseline
      }
    ];
  }

  return {
    history,
    events,
    changed: baseline || events.length > 0,
    baseline,
    snapshot
  };
}

function parseCliArgs(argv) {
  const args = {
    current: 'data/current.json',
    history: 'data/history.json',
    out: 'data/history.json'
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
  const result = updateHistory({ current, previousHistory, generatedAt: current.generatedAt });
  if (args.out === '-') {
    process.stdout.write(stableStringify(result.history));
  } else {
    await writeJsonFile(args.out, result.history);
    if (result.snapshot) {
      const snapshotPath = `data/${result.history.snapshots.at(-1).path}`;
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
