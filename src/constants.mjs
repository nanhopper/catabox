import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MARKET = 'FR';
export const DEFAULT_LANGUAGE = 'en-us';
export const USER_AGENT = 'catabox/1.0 (+https://github.com/nanhopper/catabox)';

export const SIGLS_ENDPOINT = 'https://catalog.gamepass.com/sigls/v3';
export const DISPLAY_CATALOG_ENDPOINT = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
export const DISPLAY_CATALOG_MS_CV = 'DGU1mcuYo0WMMp+F.1';

export const TIERS = [
  {
    id: 'ultimate',
    label: 'Ultimate',
    siglId: '97c6c862-d28a-4907-a3d5-c401f2296a53',
    subscriptionContext: 'cfq7ttc0khs0'
  },
  {
    id: 'premium',
    label: 'Premium',
    siglId: '09a72c0d-c466-426a-9580-b78955d8173a',
    subscriptionContext: 'cfq7ttc0p85b'
  },
  {
    id: 'essential',
    label: 'Essential',
    siglId: '34031711-5a70-4196-bab7-45757dc2294e',
    subscriptionContext: 'cfq7ttc0k5dj'
  }
];

export const PLATFORMS = [
  {
    id: 'console',
    label: 'Console',
    platformContext: 'ConsoleGen8;ConsoleGen9'
  },
  {
    id: 'pc',
    label: 'PC',
    platformContext: 'pc'
  }
];

export const TIER_IDS = TIERS.map((tier) => tier.id);
export const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id);

export const TIER_LABELS = Object.fromEntries(TIERS.map((tier) => [tier.id, tier.label]));
export const PLATFORM_LABELS = Object.fromEntries(PLATFORMS.map((platform) => [platform.id, platform.label]));

export const PRODUCT_SWAP_MAP = {
  '9PNQKHFLD2WQ': '9PNJXVCVWD4K'
};

export const SEGMENT_LABELS = {
  ultimateOnly: 'Ultimate only',
  premiumOnly: 'Premium only',
  essentialOnly: 'Essential only',
  ultimatePremium: 'Ultimate + Premium',
  ultimateEssential: 'Ultimate + Essential',
  premiumEssential: 'Premium + Essential',
  allTiers: 'All tiers'
};

export const SEGMENT_IDS = Object.keys(SEGMENT_LABELS);

export const DIFF_LABELS = {
  premiumNotUltimate: 'Premium not Ultimate',
  premiumNotEssential: 'Premium not Essential',
  ultimateNotPremium: 'Ultimate not Premium',
  essentialNotPremium: 'Essential not Premium',
  essentialNotUltimate: 'Essential not Ultimate',
  ultimateNotEssential: 'Ultimate not Essential'
};

export const GENERATED_PATHS = {
  siteDir: 'site',
  siteDataDir: 'site/data',
  snapshotsDir: 'site/data/snapshots',
  current: 'site/data/current.json',
  history: 'site/data/history.json',
  status: 'site/data/status.json',
  template: 'src/report-template.html',
  siteIndex: 'site/index.html',
  faviconSource: 'src/favicon.svg',
  favicon: 'site/favicon.svg'
};

export function getTier(tierId) {
  const tier = TIERS.find((item) => item.id === tierId);
  if (!tier) {
    throw new Error(`Unknown tier: ${tierId}`);
  }
  return tier;
}

export function getPlatform(platformId) {
  const platform = PLATFORMS.find((item) => item.id === platformId);
  if (!platform) {
    throw new Error(`Unknown platform: ${platformId}`);
  }
  return platform;
}

export function buildSiglsUrl({
  tierId,
  platformId,
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE
}) {
  const tier = getTier(tierId);
  const platform = getPlatform(platformId);
  const params = new URLSearchParams({
    id: tier.siglId,
    language,
    market,
    platformContext: platform.platformContext,
    subscriptionContext: tier.subscriptionContext
  });
  return `${SIGLS_ENDPOINT}?${params.toString()}`;
}

export function buildDisplayCatalogUrl({
  productIds,
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE
}) {
  const params = new URLSearchParams({
    bigIds: productIds.join(','),
    market,
    languages: language,
    'MS-CV': DISPLAY_CATALOG_MS_CV
  });
  return `${DISPLAY_CATALOG_ENDPOINT}?${params.toString()}`;
}

export function applyProductSwap(productId) {
  const normalized = String(productId).toUpperCase();
  return PRODUCT_SWAP_MAP[normalized] ?? normalized;
}

export function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).toUpperCase()))].sort();
}

export function intersectionSorted(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).sort();
}

export function differenceSorted(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

export function normalizeWhitespace(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function toIsoDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1900) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function sortTitle(title) {
  return normalizeWhitespace(title)
    .replace(/^(the|a|an)\s+/i, '')
    .toLocaleLowerCase('en-US');
}

export function stableData(value) {
  if (Array.isArray(value)) {
    return value.map(stableData);
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableData(value[key])])
    );
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(stableData(value), null, 2)}\n`;
}

export function hashObject(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export async function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, stableStringify(value), 'utf8');
}

export function todayFromIso(isoString) {
  return isoString.slice(0, 10);
}

export function actionRunUrlFromEnv(env = process.env) {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  }
  return null;
}

export function isMainModule(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(process.argv[1]).href;
}
