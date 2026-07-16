import { mkdir } from 'node:fs/promises';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  GENERATED_PATHS,
  actionRunUrlFromEnv,
  isMainModule,
  readJsonIfExists,
  stableStringify,
  writeJsonFile
} from './constants.mjs';
import { fetchAllLeavingSoon, fetchAllSigls } from './fetch-sigls.mjs';
import { fetchProducts, productIdsFromSiglsPayload } from './fetch-products.mjs';
import { normalizeCatalog } from './normalize-catalog.mjs';
import { readHistorySnapshots, updateHistory } from './update-history.mjs';
import { validateCatalog, validateDeterministicJson } from './validate-data.mjs';
import { renderSite } from './render-site.mjs';

function eventCounts(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function statusBase({ generatedAt, state, market, language, previousCurrent }) {
  return {
    generatedAt,
    state,
    market,
    language,
    actionRunUrl: actionRunUrlFromEnv(),
    actionRunNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    lastGoodCatalogHash: previousCurrent?.catalogHash ?? null,
    lastGoodGeneratedAt: previousCurrent?.generatedAt ?? null
  };
}

function successStatus({ generatedAt, market, language, current, historyResult, warnings, validation, sigls, leavingSoonLists, productResult, previousCurrent }) {
  return {
    ...statusBase({ generatedAt, state: 'success', market, language, previousCurrent }),
    catalogHash: current.catalogHash,
    familyHash: current.familyHash,
    catalogGeneratedAt: current.generatedAt,
    changed: historyResult.changed,
    familyChanged: historyResult.familyChanged,
    productChanged: historyResult.productChanged,
    baseline: historyResult.baseline,
    eventCounts: eventCounts(historyResult.events),
    familyEventCounts: eventCounts(historyResult.familyEvents),
    productEventCounts: eventCounts(historyResult.productEvents),
    total: current.familyCounts.total,
    productTotal: current.counts.total,
    leavingSoonTotal: current.familyCounts.leavingSoon,
    warnings: [...warnings, ...validation.warnings],
    errors: [],
    sourceHealth: {
      sigls: sigls.map((source) => ({
        tier: source.tier,
        platform: source.platform,
        status: source.status,
        count: source.count,
        sourceCount: source.sourceCount,
        url: source.url
      })),
      leavingSoon: leavingSoonLists.map((source) => ({
        platform: source.platform,
        status: source.status,
        count: source.count,
        sourceCount: source.sourceCount,
        url: source.url
      })),
      displayCatalog: {
        status: 'ok',
        requested: productResult.source.requested,
        returned: productResult.source.returned,
        missingProductIds: productResult.missingProductIds
      }
    }
  };
}

function failureStatus({ generatedAt, market, language, previousCurrent, error }) {
  return {
    ...statusBase({ generatedAt, state: 'failed', market, language, previousCurrent }),
    catalogHash: previousCurrent?.catalogHash ?? null,
    familyHash: previousCurrent?.familyHash ?? null,
    catalogGeneratedAt: previousCurrent?.generatedAt ?? null,
    changed: false,
    familyChanged: false,
    productChanged: false,
    baseline: false,
    eventCounts: {},
    familyEventCounts: {},
    productEventCounts: {},
    total: previousCurrent?.familyCounts?.total ?? 0,
    productTotal: previousCurrent?.counts?.total ?? 0,
    leavingSoonTotal: previousCurrent?.familyCounts?.leavingSoon ?? 0,
    warnings: [],
    errors: [error?.message ?? String(error)],
    sourceHealth: {
      sigls: [],
      leavingSoon: [],
      displayCatalog: {
        status: 'not-run',
        requested: 0,
        returned: 0,
        missingProductIds: []
      }
    }
  };
}

async function writeSnapshotIfNeeded(historyResult) {
  if (!historyResult.snapshot) {
    return;
  }
  const snapshotEntry = historyResult.history.snapshots.at(-1);
  await writeJsonFile(`${GENERATED_PATHS.siteDataDir}/${snapshotEntry.path}`, historyResult.snapshot);
}

async function writeSuccessOutputs({ current, historyResult, status }) {
  await mkdir(GENERATED_PATHS.snapshotsDir, { recursive: true });
  await writeSnapshotIfNeeded(historyResult);
  await writeJsonFile(GENERATED_PATHS.current, current);
  await writeJsonFile(GENERATED_PATHS.history, historyResult.history);
  await writeJsonFile(GENERATED_PATHS.status, status);
  await renderSite();
}

async function writeFailureOutput(status) {
  await writeJsonFile(GENERATED_PATHS.status, status);
}

function parseCliArgs(argv) {
  const args = {
    market: DEFAULT_MARKET,
    language: DEFAULT_LANGUAGE
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--market') {
      args.market = argv[++index];
    } else if (arg === '--language') {
      args.language = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function updateCatalog({ market = DEFAULT_MARKET, language = DEFAULT_LANGUAGE, generatedAt = new Date().toISOString() } = {}) {
  const previousCurrent = await readJsonIfExists(GENERATED_PATHS.current);
  const previousHistory = await readJsonIfExists(GENERATED_PATHS.history);
  const previousSnapshots = await readHistorySnapshots(previousHistory);
  const [sigls, leavingSoonLists] = await Promise.all([
    fetchAllSigls({ market, language, generatedAt }),
    fetchAllLeavingSoon({ market, language, generatedAt })
  ]);
  const productIds = productIdsFromSiglsPayload({ lists: sigls });
  const productResult = await fetchProducts(productIds, { market, language });
  const warnings = [];
  if (productResult.missingProductIds.length > 0) {
    warnings.push(`${productResult.missingProductIds.length} product IDs were missing from DisplayCatalog metadata.`);
  }

  const current = normalizeCatalog({
    sigls,
    leavingSoonLists,
    products: productResult.products,
    productSource: productResult.source,
    generatedAt,
    market,
    language
  });
  const preHistoryValidation = validateCatalog({ current, previousCurrent });
  if (preHistoryValidation.errors.length > 0) {
    throw new Error(`Catalog validation failed before history update:\n${preHistoryValidation.errors.join('\n')}`);
  }

  const historyResult = updateHistory({ previousHistory, previousSnapshots, current, generatedAt });
  const validation = validateCatalog({ current, previousCurrent, history: historyResult.history });
  if (validation.errors.length > 0) {
    throw new Error(`Catalog validation failed:\n${validation.errors.join('\n')}`);
  }

  const status = successStatus({
    generatedAt,
    market,
    language,
    current,
    historyResult,
    warnings,
    validation,
    sigls,
    leavingSoonLists,
    productResult,
    previousCurrent
  });

  await writeSuccessOutputs({ current, historyResult, status });
  const deterministicErrors = await validateDeterministicJson([
    GENERATED_PATHS.current,
    GENERATED_PATHS.history,
    GENERATED_PATHS.status
  ]);
  if (deterministicErrors.length > 0) {
    throw new Error(`Generated JSON is not deterministic:\n${deterministicErrors.join('\n')}`);
  }

  return { current, history: historyResult.history, status };
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  const generatedAt = new Date().toISOString();
  const previousCurrent = await readJsonIfExists(GENERATED_PATHS.current);
  try {
    const result = await updateCatalog({ market: args.market, language: args.language, generatedAt });
    process.stdout.write(stableStringify({
      state: result.status.state,
      generatedAt,
      catalogHash: result.current.catalogHash,
      familyHash: result.current.familyHash,
      total: result.current.familyCounts.total,
      productTotal: result.current.counts.total,
      warnings: result.status.warnings
    }));
  } catch (error) {
    const status = failureStatus({
      generatedAt,
      market: args.market,
      language: args.language,
      previousCurrent,
      error
    });
    await writeFailureOutput(status);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
