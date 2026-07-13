import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  GENERATED_PATHS,
  isMainModule,
  readJsonIfExists,
  writeJsonFile
} from './constants.mjs';
import {
  GAME_FAMILY_SCHEMA_VERSION,
  buildFamilyCatalog
} from './game-families.mjs';
import { renderSite } from './render-site.mjs';
import { readHistorySnapshots, updateHistory } from './update-history.mjs';
import { validateCatalog } from './validate-data.mjs';

export async function migrateFamilies({
  currentPath = GENERATED_PATHS.current,
  historyPath = GENERATED_PATHS.history,
  statusPath = GENERATED_PATHS.status
} = {}) {
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const previousHistory = await readJsonIfExists(historyPath);
  const familyCatalog = buildFamilyCatalog(current.games);
  Object.assign(current, familyCatalog);
  current.metadata ??= {};
  current.metadata.familyGrouping = {
    schemaVersion: GAME_FAMILY_SCHEMA_VERSION,
    strategy: 'conservative-normalized-title',
    productCount: current.games.length,
    familyCount: familyCatalog.families.length,
    collapsedProductCount: current.games.length - familyCatalog.families.length
  };

  const previousSnapshots = await readHistorySnapshots(previousHistory, dirname(historyPath));
  const historyResult = updateHistory({
    previousHistory,
    previousSnapshots,
    current,
    generatedAt: current.generatedAt
  });
  const validation = validateCatalog({ current, history: historyResult.history });
  if (validation.errors.length > 0) {
    throw new Error(`Family migration validation failed:\n${validation.errors.join('\n')}`);
  }

  const status = await readJsonIfExists(statusPath, {});
  const latestObservation = historyResult.history.observations.at(-1);
  status.catalogHash = current.catalogHash;
  status.familyHash = current.familyHash;
  status.catalogGeneratedAt = current.generatedAt;
  status.total = current.familyCounts.total;
  status.productTotal = current.counts.total;
  status.changed = latestObservation?.changed ?? false;
  status.baseline = latestObservation?.baseline ?? false;
  status.eventCounts = latestObservation?.familyEventCounts ?? {};
  status.familyEventCounts = latestObservation?.familyEventCounts ?? {};
  status.productEventCounts = latestObservation?.productEventCounts ?? {};
  status.familyChanged = latestObservation?.familyChanged ?? false;
  status.productChanged = latestObservation?.productChanged ?? false;

  await writeJsonFile(currentPath, current);
  await writeJsonFile(historyPath, historyResult.history);
  await writeJsonFile(statusPath, status);
  await renderSite();
  return { current, history: historyResult.history, status };
}

if (isMainModule(import.meta.url)) {
  migrateFamilies().then(({ current }) => {
    process.stdout.write(`Migrated ${current.counts.total} products into ${current.familyCounts.total} families.\n`);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
