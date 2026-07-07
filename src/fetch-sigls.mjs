import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  PLATFORM_IDS,
  TIER_IDS,
  USER_AGENT,
  applyProductSwap,
  buildSiglsUrl,
  getPlatform,
  getTier,
  stableStringify,
  todayFromIso,
  isMainModule,
  writeJsonFile
} from './constants.mjs';

export async function requestJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (!fetchImpl) {
    throw new Error('No fetch implementation is available. Use Node 20 or newer.');
  }
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function parseSiglsResponse(payload) {
  if (!Array.isArray(payload)) {
    throw new Error('SIGLS response was not an array');
  }
  const [header = {}, ...entries] = payload;
  const sourceProductIds = entries
    .map((entry) => entry?.id)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim().toUpperCase());
  const swapsApplied = [];
  const productIds = sourceProductIds.map((id) => {
    const swapped = applyProductSwap(id);
    if (swapped !== id) {
      swapsApplied.push({ from: id, to: swapped });
    }
    return swapped;
  });
  return {
    header,
    sourceProductIds: [...new Set(sourceProductIds)].sort(),
    productIds: [...new Set(productIds)].sort(),
    swapsApplied
  };
}

export async function fetchSiglsList({
  tierId,
  platformId,
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE,
  generatedAt = new Date().toISOString(),
  fetchImpl
}) {
  const tier = getTier(tierId);
  const platform = getPlatform(platformId);
  const url = buildSiglsUrl({ tierId, platformId, market, language });
  const payload = await requestJson(url, { fetchImpl });
  const parsed = parseSiglsResponse(payload);
  return {
    tier: tier.id,
    tierLabel: tier.label,
    platform: platform.id,
    platformLabel: platform.label,
    siglId: tier.siglId,
    subscriptionContext: tier.subscriptionContext,
    platformContext: platform.platformContext,
    url,
    title: parsed.header?.title ?? null,
    description: parsed.header?.description ?? null,
    fetchedAt: generatedAt,
    fetchedDate: todayFromIso(generatedAt),
    status: 'ok',
    count: parsed.productIds.length,
    sourceCount: parsed.sourceProductIds.length,
    productIds: parsed.productIds,
    sourceProductIds: parsed.sourceProductIds,
    swapsApplied: parsed.swapsApplied
  };
}

export async function fetchAllSigls({
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE,
  generatedAt = new Date().toISOString(),
  fetchImpl
} = {}) {
  const jobs = [];
  for (const tierId of TIER_IDS) {
    for (const platformId of PLATFORM_IDS) {
      jobs.push(fetchSiglsList({ tierId, platformId, market, language, generatedAt, fetchImpl }));
    }
  }
  return Promise.all(jobs);
}

function parseCliArgs(argv) {
  const args = {
    market: DEFAULT_MARKET,
    language: DEFAULT_LANGUAGE,
    out: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--market') {
      args.market = argv[++index];
    } else if (arg === '--language') {
      args.language = argv[++index];
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
  const generatedAt = new Date().toISOString();
  const lists = await fetchAllSigls({
    market: args.market,
    language: args.language,
    generatedAt
  });
  const payload = {
    generatedAt,
    market: args.market,
    language: args.language,
    lists
  };
  if (args.out) {
    await writeJsonFile(args.out, payload);
  } else {
    process.stdout.write(stableStringify(payload));
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
