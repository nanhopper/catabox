import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  DIFF_LABELS,
  MAX_GAME_SCREENSHOTS,
  PLATFORM_IDS,
  PLATFORM_LABELS,
  PRODUCT_SWAP_MAP,
  GENERATED_PATHS,
  SEGMENT_IDS,
  SEGMENT_LABELS,
  TIER_IDS,
  TIER_LABELS,
  differenceSorted,
  hashObject,
  isMainModule,
  intersectionSorted,
  normalizeWhitespace,
  sortTitle,
  stableStringify,
  toIsoDate,
  uniqueSorted,
  writeJsonFile
} from './constants.mjs';
import {
  GAME_FAMILY_SCHEMA_VERSION,
  buildFamilyCatalog,
  segmentForTiers
} from './game-families.mjs';

function localizedProperties(product) {
  return product?.LocalizedProperties?.[0] ?? {};
}

function productProperties(product) {
  return product?.Properties ?? {};
}

function skuAvailability(product) {
  return product?.DisplaySkuAvailabilities?.[0]?.Availabilities?.[0] ?? {};
}

function sku(product) {
  return product?.DisplaySkuAvailabilities?.[0]?.Sku ?? {};
}

function imageUrl(image) {
  const uri = image?.Uri;
  if (!uri) {
    return null;
  }
  return uri.startsWith('//') ? `https:${uri}` : uri;
}

function pickImage(images, purposes) {
  if (!Array.isArray(images)) {
    return null;
  }
  for (const purpose of purposes) {
    const matches = images
      .filter((image) => image?.ImagePurpose === purpose && image?.Uri)
      .sort((left, right) => (right.Width ?? 0) * (right.Height ?? 0) - (left.Width ?? 0) * (left.Height ?? 0));
    if (matches[0]) {
      return imageUrl(matches[0]);
    }
  }
  return imageUrl(images.find((image) => image?.Uri));
}

function screenshotThumbnailUrl(image) {
  const sourceUrl = imageUrl(image);
  if (!sourceUrl) {
    return null;
  }
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'http:') {
    url.protocol = 'https:';
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.hostname.toLocaleLowerCase('en-US') !== 'store-images.s-microsoft.com') {
    return null;
  }
  url.searchParams.set('w', '640');
  url.searchParams.set('h', '360');
  url.searchParams.set('q', '80');
  url.searchParams.set('format', 'jpg');
  return url.href;
}

function screenshotIdentity(image) {
  const hash = normalizeWhitespace(image?.UnscaledImageSHA256Hash);
  if (hash) {
    return `hash:${hash}`;
  }
  const sourceUrl = imageUrl(image);
  return sourceUrl ? `url:${sourceUrl}` : null;
}

function screenshotsForProduct(images) {
  if (!Array.isArray(images)) {
    return [];
  }
  const screenshots = [];
  const seen = new Set();
  for (const image of images) {
    if (String(image?.ImagePurpose ?? '').toLocaleLowerCase('en-US') !== 'screenshot') {
      continue;
    }
    const identity = screenshotIdentity(image);
    const thumbnailUrl = screenshotThumbnailUrl(image);
    const thumbnailIdentity = thumbnailUrl ? `thumbnail:${thumbnailUrl}` : null;
    if (!identity || !thumbnailUrl || seen.has(identity) || seen.has(thumbnailIdentity)) {
      continue;
    }
    seen.add(identity);
    seen.add(thumbnailIdentity);
    screenshots.push(thumbnailUrl);
    if (screenshots.length === MAX_GAME_SCREENSHOTS) {
      break;
    }
  }
  return screenshots;
}

function pickContentRating(product) {
  const ratings = [
    ...(product?.MarketProperties ?? []).flatMap((item) => item?.ContentRatings ?? []),
    ...(productProperties(product).ContentRatings ?? [])
  ];
  if (!Array.isArray(ratings) || ratings.length === 0) {
    return { ratingSystem: null, ratingId: null };
  }
  const rating = ratings.find((item) => /PEGI/i.test(item?.RatingSystem ?? '')) ?? ratings[0];
  return {
    ratingSystem: rating?.RatingSystem ?? null,
    ratingId: rating?.RatingId ?? rating?.Rating ?? rating?.RatingValue ?? null
  };
}

function pegiRating(product) {
  const ratings = [
    ...(product?.MarketProperties ?? []).flatMap((item) => item?.ContentRatings ?? []),
    ...(productProperties(product).ContentRatings ?? [])
  ];
  const rating = ratings.find((item) => /PEGI/i.test(item?.RatingSystem ?? ''));
  const ratingId = rating?.RatingId ?? rating?.Rating ?? rating?.RatingValue ?? null;
  const normalized = typeof ratingId === 'string' ? ratingId.match(/(\d{1,2})$/)?.[1] ?? ratingId : ratingId;
  return normalized ? `PEGI ${normalized}` : null;
}

function productGenres(product) {
  const props = productProperties(product);
  const genres = [];
  if (Array.isArray(props.Categories)) {
    genres.push(...props.Categories);
  }
  if (props.Category) {
    genres.push(props.Category);
  }
  return [...new Set(genres.map(normalizeWhitespace).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) ?? null;
}

function marketProperties(product, market) {
  const properties = product?.MarketProperties;
  if (!Array.isArray(properties) || properties.length === 0) {
    return [];
  }
  const normalizedMarket = String(market).toUpperCase();
  const matching = properties.filter((item) => {
    const itemMarket = typeof item?.Market === 'string' ? item.Market.toUpperCase() : null;
    const markets = Array.isArray(item?.Markets) ? item.Markets.map((value) => String(value).toUpperCase()) : [];
    return itemMarket === normalizedMarket || markets.includes(normalizedMarket);
  });
  return matching.length > 0 ? matching : properties;
}

function marketListIncludes(values, market) {
  return Array.isArray(values) && values.some((value) => String(value).toUpperCase() === market);
}

function isAvailableInMarket(product, market) {
  const normalizedMarket = String(market).toUpperCase();
  const localized = localizedProperties(product);
  const skuData = sku(product);
  if (marketListIncludes(localized.Markets, normalizedMarket)) return true;
  for (const item of product?.MarketProperties ?? []) {
    if (String(item?.Market ?? '').toUpperCase() === normalizedMarket || marketListIncludes(item?.Markets, normalizedMarket)) {
      return true;
    }
  }
  for (const item of product?.DisplaySkuAvailabilities ?? []) {
    if (marketListIncludes(item?.Markets, normalizedMarket)) return true;
    for (const availability of [...(item?.Availabilities ?? []), ...(item?.HistoricalBestAvailabilities ?? [])]) {
      if (marketListIncludes(availability?.Markets, normalizedMarket)) return true;
    }
    for (const marketProperty of item?.Sku?.MarketProperties ?? []) {
      if (String(marketProperty?.Market ?? '').toUpperCase() === normalizedMarket || marketListIncludes(marketProperty?.Markets, normalizedMarket)) {
        return true;
      }
    }
  }
  return marketListIncludes(skuData?.LocalizedProperties?.[0]?.Markets, normalizedMarket);
}

function releaseDateForProduct(product, market) {
  const availability = skuAvailability(product);
  const skuData = sku(product);
  const marketProps = marketProperties(product, market);
  return firstValue(
    ...marketProps.map((item) => toIsoDate(item?.OriginalReleaseDate)),
    toIsoDate(availability?.Properties?.OriginalReleaseDate),
    ...(skuData?.MarketProperties ?? []).map((item) => toIsoDate(item?.FirstAvailableDate)),
    toIsoDate(productProperties(product).OriginalReleaseDate)
  );
}

function productAttributes(product) {
  const attributes = productProperties(product).Attributes;
  if (!Array.isArray(attributes)) {
    return [];
  }
  return attributes.filter((attribute) => normalizeWhitespace(attribute?.Name));
}

function skuFeatureText(product) {
  return (product?.DisplaySkuAvailabilities ?? [])
    .flatMap((item) => item?.Sku?.LocalizedProperties ?? [])
    .flatMap((localized) => localized?.Features ?? [])
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function modeCount(attribute) {
  const minimum = Number(attribute?.Minimum);
  const maximum = Number(attribute?.Maximum);
  if (!Number.isFinite(minimum) || minimum <= 0 || !Number.isFinite(maximum) || maximum <= 0) {
    return '';
  }
  return minimum === maximum ? ` (${minimum})` : ` (${minimum}-${maximum})`;
}

function addMode(modes, key, label, count = '') {
  if (!modes.has(key)) {
    modes.set(key, `${label}${count}`);
  }
}

function addModeFromFeature(modes, feature, pattern, key, label) {
  const match = feature.match(pattern);
  if (!match) {
    return;
  }
  const count = match[1] ? ` (${match[1].replace(/\s+/g, '')})` : '';
  addMode(modes, key, label, count);
}

function playerModes(product) {
  const modes = new Map();
  for (const attribute of productAttributes(product)) {
    const name = normalizeWhitespace(attribute.Name).toLocaleLowerCase('en-US');
    if (/single.?player/.test(name)) addMode(modes, 'single', 'Single player', modeCount(attribute));
    if (/online.?multi.?player|onlinemultiplayer|cross.?platform.?multi.?player/.test(name)) addMode(modes, 'onlineMultiplayer', 'Online multiplayer', modeCount(attribute));
    if (/local.?multi.?player|shared.?split.?screen/.test(name)) addMode(modes, 'localMultiplayer', 'Local multiplayer', modeCount(attribute));
    if (/online.?co.?op|onlinecoop|coopsupportonline|cross.?platform.?coop/.test(name)) addMode(modes, 'onlineCoop', 'Online co-op', modeCount(attribute));
    if (/local.?co.?op|couch.?co.?op|split.?screen.?co.?op|shared.?screen.?co.?op/.test(name)) addMode(modes, 'localCoop', 'Local co-op', modeCount(attribute));
  }
  for (const feature of skuFeatureText(product)) {
    addModeFromFeature(modes, feature, /^single[-\s]?player(?:\s*\(([^)]+)\))?/i, 'single', 'Single player');
    addModeFromFeature(modes, feature, /^online multiplayer(?:\s*\(([^)]+)\))?/i, 'onlineMultiplayer', 'Online multiplayer');
    addModeFromFeature(modes, feature, /^local multiplayer(?:\s*\(([^)]+)\))?/i, 'localMultiplayer', 'Local multiplayer');
    addModeFromFeature(modes, feature, /^online co[-\s]?op(?:\s*\(([^)]+)\))?/i, 'onlineCoop', 'Online co-op');
    addModeFromFeature(modes, feature, /^local co[-\s]?op(?:\s*\(([^)]+)\))?/i, 'localCoop', 'Local co-op');
  }
  const playerModes = [...modes.values()];
  const supportsSinglePlayer = modes.has('single');
  const supportsOnlineMultiplayer = modes.has('onlineMultiplayer');
  const supportsLocalMultiplayer = modes.has('localMultiplayer');
  const supportsOnlineCoop = modes.has('onlineCoop');
  const supportsLocalCoop = modes.has('localCoop');
  return {
    playerModes,
    supportsSinglePlayer,
    supportsMultiplayer: supportsOnlineMultiplayer || supportsLocalMultiplayer,
    supportsOnlineMultiplayer,
    supportsLocalMultiplayer,
    supportsCoop: supportsOnlineCoop || supportsLocalCoop,
    supportsOnlineCoop,
    supportsLocalCoop
  };
}

function storeSlug(title) {
  return normalizeWhitespace(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'game';
}

export function xboxStoreUrl(productId, title) {
  return `https://www.xbox.com/en-us/games/store/${storeSlug(title)}/${encodeURIComponent(productId)}`;
}

function metadataForProduct(product, productId, market) {
  const localized = localizedProperties(product);
  const rating = pickContentRating(product);
  const title = normalizeWhitespace(firstValue(localized.ProductTitle, productId));
  const shortDescription = normalizeWhitespace(localized.ShortDescription);
  const modes = playerModes(product);
  return {
    title,
    sortTitle: sortTitle(title),
    publisher: normalizeWhitespace(localized.PublisherName),
    developer: normalizeWhitespace(localized.DeveloperName),
    genres: productGenres(product),
    ratingSystem: rating.ratingSystem,
    ratingId: rating.ratingId,
    poster: pickImage(localized.Images, ['Poster', 'BoxArt', 'BrandedKeyArt', 'Tile']),
    boxArt: pickImage(localized.Images, ['BoxArt', 'Poster', 'Tile']),
    heroArt: pickImage(localized.Images, ['SuperHeroArt', 'TitledHeroArt', 'HeroArt', 'BrandedKeyArt']),
    screenshots: screenshotsForProduct(localized.Images),
    shortDescription,
    description: normalizeWhitespace(firstValue(shortDescription, localized.ProductTitle)),
    releaseDate: releaseDateForProduct(product, market),
    availableInFR: isAvailableInMarket(product, 'FR'),
    pegiRating: pegiRating(product),
    ...modes,
    url: xboxStoreUrl(productId, title)
  };
}

function emptyRawLists() {
  return Object.fromEntries(
    TIER_IDS.map((tierId) => [
      tierId,
      {
        all: [],
        console: [],
        pc: []
      }
    ])
  );
}

function emptySegments() {
  return Object.fromEntries(SEGMENT_IDS.map((segmentId) => [segmentId, []]));
}

function computeDiffs(tierSets) {
  return {
    premiumNotUltimate: differenceSorted([...tierSets.premium], tierSets.ultimate),
    premiumNotEssential: differenceSorted([...tierSets.premium], tierSets.essential),
    ultimateNotPremium: differenceSorted([...tierSets.ultimate], tierSets.premium),
    essentialNotPremium: differenceSorted([...tierSets.essential], tierSets.premium),
    essentialNotUltimate: differenceSorted([...tierSets.essential], tierSets.ultimate),
    ultimateNotEssential: differenceSorted([...tierSets.ultimate], tierSets.essential)
  };
}

function normalizeSourceLists(sigls) {
  return sigls.map((list) => ({
    tier: list.tier,
    tierLabel: list.tierLabel ?? TIER_LABELS[list.tier],
    platform: list.platform,
    platformLabel: list.platformLabel ?? PLATFORM_LABELS[list.platform],
    siglId: list.siglId,
    subscriptionContext: list.subscriptionContext,
    platformContext: list.platformContext,
    title: list.title ?? null,
    description: list.description ?? null,
    count: list.productIds?.length ?? 0,
    sourceCount: list.sourceProductIds?.length ?? list.productIds?.length ?? 0,
    status: list.status ?? 'ok',
    fetchedAt: list.fetchedAt ?? null,
    url: list.url,
    swapsApplied: list.swapsApplied ?? []
  }));
}

function normalizeLeavingSoonSourceLists(lists) {
  return lists.map((list) => ({
    kind: 'leavingSoon',
    platform: list.platform,
    platformLabel: list.platformLabel ?? PLATFORM_LABELS[list.platform],
    siglId: list.siglId,
    title: list.title ?? null,
    description: list.description ?? null,
    count: list.productIds?.length ?? 0,
    sourceCount: list.sourceProductIds?.length ?? list.productIds?.length ?? 0,
    status: list.status ?? 'ok',
    fetchedAt: list.fetchedAt ?? null,
    url: list.url,
    swapsApplied: list.swapsApplied ?? []
  }));
}

function platformCounts(games) {
  return Object.fromEntries(
    PLATFORM_IDS.map((platformId) => [platformId, games.filter((game) => game.platforms.includes(platformId)).length])
  );
}

function tierPlatformCounts(rawLists) {
  return Object.fromEntries(
    TIER_IDS.map((tierId) => [
      tierId,
      Object.fromEntries(PLATFORM_IDS.map((platformId) => [platformId, rawLists[tierId][platformId].length]))
    ])
  );
}

function segmentCounts(segments) {
  return Object.fromEntries(Object.entries(segments).map(([segmentId, ids]) => [segmentId, ids.length]));
}

export function normalizeCatalog({
  sigls,
  leavingSoonLists = [],
  products = {},
  productSource = null,
  generatedAt = new Date().toISOString(),
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE
}) {
  if (!Array.isArray(sigls) || sigls.length === 0) {
    throw new Error('normalizeCatalog requires SIGLS lists');
  }

  const rawLists = emptyRawLists();
  for (const list of sigls) {
    if (!TIER_IDS.includes(list.tier)) {
      throw new Error(`Unknown tier in SIGLS list: ${list.tier}`);
    }
    if (!PLATFORM_IDS.includes(list.platform)) {
      throw new Error(`Unknown platform in SIGLS list: ${list.platform}`);
    }
    rawLists[list.tier][list.platform] = uniqueSorted(list.productIds ?? []);
  }

  for (const tierId of TIER_IDS) {
    rawLists[tierId].all = uniqueSorted(PLATFORM_IDS.flatMap((platformId) => rawLists[tierId][platformId]));
  }

  const tierSets = Object.fromEntries(TIER_IDS.map((tierId) => [tierId, new Set(rawLists[tierId].all)]));
  const allProductIds = uniqueSorted(TIER_IDS.flatMap((tierId) => rawLists[tierId].all));
  const allProductIdSet = new Set(allProductIds);
  const leavingSoon = {
    all: [],
    console: [],
    pc: [],
    unmatched: Object.fromEntries(PLATFORM_IDS.map((platformId) => [platformId, []]))
  };
  for (const list of leavingSoonLists) {
    if (!PLATFORM_IDS.includes(list.platform)) {
      throw new Error(`Unknown platform in leaving-soon SIGLS list: ${list.platform}`);
    }
    const sourceIds = uniqueSorted(list.productIds ?? []);
    leavingSoon[list.platform] = sourceIds.filter((id) => allProductIdSet.has(id));
    leavingSoon.unmatched[list.platform] = sourceIds.filter((id) => !allProductIdSet.has(id));
  }
  leavingSoon.all = uniqueSorted(PLATFORM_IDS.flatMap((platformId) => leavingSoon[platformId]));
  const segments = emptySegments();
  const games = allProductIds.map((productId) => {
    const memberships = TIER_IDS.filter((tierId) => tierSets[tierId].has(productId));
    const platformByTier = Object.fromEntries(
      TIER_IDS.map((tierId) => [
        tierId,
        PLATFORM_IDS.filter((platformId) => rawLists[tierId][platformId].includes(productId))
      ]).filter(([, platforms]) => platforms.length > 0)
    );
    const platforms = uniqueSorted(Object.values(platformByTier).flat()).map((platformId) => platformId.toLowerCase());
    const leavingSoonPlatforms = PLATFORM_IDS.filter((platformId) => leavingSoon[platformId].includes(productId));
    const segment = segmentForTiers(memberships);
    const metadata = metadataForProduct(products[productId], productId, market);
    const game = {
      id: productId,
      ...metadata,
      leavingSoon: leavingSoonPlatforms.length > 0,
      leavingSoonPlatforms,
      memberships,
      platformByTier,
      platforms,
      segment
    };
    segments[segment].push(productId);
    return game;
  });

  games.sort((left, right) => left.sortTitle.localeCompare(right.sortTitle) || left.id.localeCompare(right.id));
  for (const segmentId of SEGMENT_IDS) {
    segments[segmentId] = segments[segmentId].sort();
  }

  const diffs = computeDiffs(tierSets);
  const {
    families,
    familyHash,
    familyCounts,
    familyDiffs,
    familySegments
  } = buildFamilyCatalog(games);
  const catalogHash = hashObject({
    rawLists,
    games: games.map((game) => ({
      id: game.id,
      title: game.title,
      memberships: game.memberships,
      platformByTier: game.platformByTier,
      platforms: game.platforms,
      segment: game.segment
    }))
  });
  const missingProductIds = allProductIds.filter((id) => !products[id]);

  return {
    generatedAt,
    catalogHash,
    familyHash,
    market,
    language,
    counts: {
      total: games.length,
      tiers: Object.fromEntries(TIER_IDS.map((tierId) => [tierId, rawLists[tierId].all.length])),
      platforms: platformCounts(games),
      tierPlatforms: tierPlatformCounts(rawLists),
      leavingSoon: leavingSoon.all.length,
      leavingSoonPlatforms: Object.fromEntries(
        PLATFORM_IDS.map((platformId) => [platformId, leavingSoon[platformId].length])
      ),
      segments: segmentCounts(segments),
      diffs: Object.fromEntries(Object.entries(diffs).map(([key, ids]) => [key, ids.length]))
    },
    familyCounts,
    labels: {
      tiers: TIER_LABELS,
      platforms: PLATFORM_LABELS,
      segments: SEGMENT_LABELS,
      diffs: DIFF_LABELS
    },
    sourceLists: normalizeSourceLists(sigls),
    leavingSoonSourceLists: normalizeLeavingSoonSourceLists(leavingSoonLists),
    rawLists,
    leavingSoon,
    games,
    families,
    diffs,
    familyDiffs,
    segments,
    familySegments,
    metadata: {
      generatedBy: 'catabox',
      source: 'Xbox Game Pass public SIGLS plus Microsoft DisplayCatalog metadata',
      productSwapMap: PRODUCT_SWAP_MAP,
      productSource,
      missingProductIds,
      familyGrouping: {
        schemaVersion: GAME_FAMILY_SCHEMA_VERSION,
        strategy: 'conservative-normalized-title',
        productCount: games.length,
        familyCount: families.length,
        collapsedProductCount: games.length - families.length
      },
      overlap: {
        ultimatePremium: intersectionSorted(rawLists.ultimate.all, rawLists.premium.all),
        ultimateEssential: intersectionSorted(rawLists.ultimate.all, rawLists.essential.all),
        premiumEssential: intersectionSorted(rawLists.premium.all, rawLists.essential.all)
      }
    }
  };
}

function parseCliArgs(argv) {
  const args = {
    sigls: null,
    products: null,
    out: GENERATED_PATHS.current,
    market: DEFAULT_MARKET,
    language: DEFAULT_LANGUAGE
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sigls') {
      args.sigls = argv[++index];
    } else if (arg === '--products') {
      args.products = argv[++index];
    } else if (arg === '--out') {
      args.out = argv[++index];
    } else if (arg === '--market') {
      args.market = argv[++index];
    } else if (arg === '--language') {
      args.language = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.sigls || !args.products) {
    throw new Error('Pass --sigls <file> and --products <file>');
  }
  const siglsPayload = JSON.parse(await readFile(args.sigls, 'utf8'));
  const productsPayload = JSON.parse(await readFile(args.products, 'utf8'));
  const current = normalizeCatalog({
    sigls: siglsPayload.lists ?? siglsPayload,
    leavingSoonLists: siglsPayload.leavingSoonLists ?? [],
    products: productsPayload.products ?? productsPayload,
    productSource: productsPayload.source ?? null,
    market: args.market,
    language: args.language
  });
  if (args.out === '-') {
    process.stdout.write(stableStringify(current));
  } else {
    await writeJsonFile(args.out, current);
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
