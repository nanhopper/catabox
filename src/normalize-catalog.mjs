import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  DIFF_LABELS,
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

function localizedProperties(product) {
  return product?.LocalizedProperties?.[0] ?? {};
}

function productProperties(product) {
  return product?.Properties ?? {};
}

function skuAvailability(product) {
  return product?.DisplaySkuAvailabilities?.[0]?.Availabilities?.[0] ?? {};
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

function pickContentRating(product) {
  const ratings = productProperties(product).ContentRatings;
  if (!Array.isArray(ratings) || ratings.length === 0) {
    return { ratingSystem: null, ratingId: null };
  }
  const rating = ratings.find((item) => /PEGI/i.test(item?.RatingSystem ?? '')) ?? ratings[0];
  return {
    ratingSystem: rating?.RatingSystem ?? null,
    ratingId: rating?.RatingId ?? rating?.Rating ?? rating?.RatingValue ?? null
  };
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

function metadataForProduct(product, productId) {
  const localized = localizedProperties(product);
  const props = productProperties(product);
  const availability = skuAvailability(product);
  const rating = pickContentRating(product);
  const title = normalizeWhitespace(firstValue(localized.ProductTitle, productId));
  const releaseDate = toIsoDate(availability?.Conditions?.StartDate) ?? toIsoDate(props.OriginalReleaseDate);
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
    description: normalizeWhitespace(firstValue(localized.ShortDescription, localized.ProductDescription, localized.ProductTitle)),
    releaseDate,
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

function segmentForTiers(tiers) {
  const hasUltimate = tiers.includes('ultimate');
  const hasPremium = tiers.includes('premium');
  const hasEssential = tiers.includes('essential');
  if (hasUltimate && hasPremium && hasEssential) {
    return 'allTiers';
  }
  if (hasUltimate && hasPremium) {
    return 'ultimatePremium';
  }
  if (hasUltimate && hasEssential) {
    return 'ultimateEssential';
  }
  if (hasPremium && hasEssential) {
    return 'premiumEssential';
  }
  if (hasUltimate) {
    return 'ultimateOnly';
  }
  if (hasPremium) {
    return 'premiumOnly';
  }
  return 'essentialOnly';
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
    const segment = segmentForTiers(memberships);
    const metadata = metadataForProduct(products[productId], productId);
    const game = {
      id: productId,
      ...metadata,
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
    market,
    language,
    counts: {
      total: games.length,
      tiers: Object.fromEntries(TIER_IDS.map((tierId) => [tierId, rawLists[tierId].all.length])),
      platforms: platformCounts(games),
      tierPlatforms: tierPlatformCounts(rawLists),
      segments: segmentCounts(segments),
      diffs: Object.fromEntries(Object.entries(diffs).map(([key, ids]) => [key, ids.length]))
    },
    labels: {
      tiers: TIER_LABELS,
      platforms: PLATFORM_LABELS,
      segments: SEGMENT_LABELS,
      diffs: DIFF_LABELS
    },
    sourceLists: normalizeSourceLists(sigls),
    rawLists,
    games,
    diffs,
    segments,
    metadata: {
      generatedBy: 'catabox',
      source: 'Xbox Game Pass public SIGLS plus Microsoft DisplayCatalog metadata',
      productSwapMap: PRODUCT_SWAP_MAP,
      productSource,
      missingProductIds,
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
