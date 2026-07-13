import { createHash } from 'node:crypto';
import {
  MAX_GAME_SCREENSHOTS,
  PLATFORM_IDS,
  SEGMENT_IDS,
  TIER_IDS,
  hashObject,
  normalizeWhitespace,
  sortTitle
} from './constants.mjs';

export const GAME_FAMILY_SCHEMA_VERSION = 1;

const ROMAN_NUMERALS = {
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10'
};

const PLATFORM_SUFFIX_PATTERNS = [
  /\s*[\[(]\s*(?:win(?:dows)?(?:\s+(?:10|11|pc))?(?:\s+version)?|pc(?:\s+version)?|xbox(?:\s+(?:one|series\s+x\s*\|\s*s))?|x\s*\|\s*s)\s*[\])]\s*$/i,
  /\s*[-:\u2010-\u2015]\s*win(?:\s+version)?\s*$/i,
  /\s*(?:[-:\u2010-\u2015]\s*)?for\s+windows(?:\s+(?:10|11))?(?:\s*(?:\+|and)\s*launcher)?(?:\s+version)?\s*$/i,
  /\s*(?:[-:\u2010-\u2015]\s*)?windows(?:\s+(?:10|11))?(?:\s*(?:\+|and)\s*launcher)?(?:\s+version)?\s*$/i,
  /\s*(?:[-:\u2010-\u2015]\s*)?for\s+xbox(?:\s+(?:one|series\s+x\s*\|\s*s))?(?:\s+version)?\s*$/i,
  /\s*(?:[-:\u2010-\u2015]\s*)?xbox\s+(?:one|series\s+x\s*\|\s*s)(?:\s+version)?\s*$/i,
  /\s*(?:[-:\u2010-\u2015]\s*)?pc(?:\s+version)?\s*$/i
];

const BOOLEAN_FIELDS = [
  'supportsSinglePlayer',
  'supportsMultiplayer',
  'supportsOnlineMultiplayer',
  'supportsLocalMultiplayer',
  'supportsCoop',
  'supportsOnlineCoop',
  'supportsLocalCoop'
];

function normalizeTitleText(title) {
  return normalizeWhitespace(title)
    .replace(/[\u00a9\u00ae\u2120\u2122]/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d)([a-z])/gi, '$1 $2')
    .toLocaleLowerCase('en-US')
    .replace(/&/g, ' and ')
    .replace(/['\u2018\u2019`\u00b4]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((token) => ROMAN_NUMERALS[token] ?? token)
    .join(' ');
}

export function stripPlatformQualifier(title) {
  let normalized = normalizeWhitespace(title);
  let previous;
  do {
    previous = normalized;
    for (const pattern of PLATFORM_SUFFIX_PATTERNS) {
      normalized = normalized.replace(pattern, '').trim();
    }
  } while (normalized !== previous);
  return normalized || normalizeWhitespace(title);
}

export function gameFamilyKey(title) {
  return normalizeTitleText(stripPlatformQualifier(title));
}

export function gameFamilyId(key) {
  const digest = createHash('sha256')
    .update(`catabox-game-family:${GAME_FAMILY_SCHEMA_VERSION}:${key}`)
    .digest('hex');
  return `family-${digest}`;
}

export function segmentForTiers(tiers) {
  const hasUltimate = tiers.includes('ultimate');
  const hasPremium = tiers.includes('premium');
  const hasEssential = tiers.includes('essential');
  if (hasUltimate && hasPremium && hasEssential) return 'allTiers';
  if (hasUltimate && hasPremium) return 'ultimatePremium';
  if (hasUltimate && hasEssential) return 'ultimateEssential';
  if (hasPremium && hasEssential) return 'premiumEssential';
  if (hasUltimate) return 'ultimateOnly';
  if (hasPremium) return 'premiumOnly';
  return 'essentialOnly';
}

function hasPlatformQualifier(title) {
  return stripPlatformQualifier(title) !== normalizeWhitespace(title);
}

function compareVariants(left, right) {
  return Number(hasPlatformQualifier(left.title)) - Number(hasPlatformQualifier(right.title))
    || stripPlatformQualifier(left.title).length - stripPlatformQualifier(right.title).length
    || normalizeWhitespace(left.title).length - normalizeWhitespace(right.title).length
    || String(left.id).localeCompare(String(right.id));
}

function firstValue(variants, field, fallback = '') {
  return variants.map((variant) => variant[field]).find((value) => value != null && value !== '') ?? fallback;
}

function uniqueStrings(values) {
  const byKey = new Map();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = value.trim();
    const key = normalized.toLocaleLowerCase('en-US');
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function validReleaseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year < 9990;
}

function familyReleaseDate(variants) {
  return variants
    .map((variant) => variant.releaseDate)
    .filter(validReleaseDate)
    .sort()[0] ?? null;
}

function familyAvailability(variants) {
  if (variants.some((variant) => variant.availableInFR === true)) return true;
  if (variants.every((variant) => variant.availableInFR === false)) return false;
  return null;
}

function familyScreenshots(variants) {
  const screenshots = [];
  const seen = new Set();
  for (const variant of variants) {
    for (const screenshot of variant.screenshots ?? []) {
      if (typeof screenshot !== 'string' || !screenshot || seen.has(screenshot)) continue;
      seen.add(screenshot);
      screenshots.push(screenshot);
      if (screenshots.length === MAX_GAME_SCREENSHOTS) return screenshots;
    }
  }
  return screenshots;
}

function aggregatePlatformByTier(variants) {
  return Object.fromEntries(
    TIER_IDS.map((tierId) => {
      const platforms = PLATFORM_IDS.filter((platformId) =>
        variants.some((variant) => variant.platformByTier?.[tierId]?.includes(platformId))
      );
      return [tierId, platforms];
    }).filter(([, platforms]) => platforms.length > 0)
  );
}

function buildFamily(key, members) {
  const variants = [...members].sort(compareVariants);
  const representative = variants[0];
  const platformByTier = aggregatePlatformByTier(variants);
  const memberships = TIER_IDS.filter((tierId) => platformByTier[tierId]?.length > 0);
  const platforms = PLATFORM_IDS.filter((platformId) =>
    Object.values(platformByTier).some((tierPlatforms) => tierPlatforms.includes(platformId))
  );
  const title = stripPlatformQualifier(representative.title);
  const family = {
    id: gameFamilyId(key),
    familyKey: key,
    familySchemaVersion: GAME_FAMILY_SCHEMA_VERSION,
    title,
    sortTitle: sortTitle(title),
    primaryVariantId: representative.id,
    variantIds: variants.map((variant) => variant.id),
    variantCount: variants.length,
    publisher: firstValue(variants, 'publisher'),
    developer: firstValue(variants, 'developer'),
    genres: uniqueStrings(variants.flatMap((variant) => variant.genres ?? [])),
    ratingSystem: firstValue(variants, 'ratingSystem', null),
    ratingId: firstValue(variants, 'ratingId', null),
    pegiRating: firstValue(variants, 'pegiRating', null),
    poster: firstValue(variants, 'poster', null),
    boxArt: firstValue(variants, 'boxArt', null),
    heroArt: firstValue(variants, 'heroArt', null),
    screenshots: familyScreenshots(variants),
    shortDescription: firstValue(variants, 'shortDescription'),
    description: firstValue(variants, 'description'),
    releaseDate: familyReleaseDate(variants),
    availableInFR: familyAvailability(variants),
    playerModes: uniqueStrings(variants.flatMap((variant) => variant.playerModes ?? [])),
    memberships,
    platformByTier,
    platforms,
    segment: segmentForTiers(memberships),
    url: representative.url
  };
  for (const field of BOOLEAN_FIELDS) {
    family[field] = variants.some((variant) => variant[field] === true);
  }
  return family;
}

export function buildGameFamilies(games) {
  const grouped = new Map();
  for (const game of games) {
    const key = gameFamilyKey(game.title) || `product-${String(game.id).toLocaleLowerCase('en-US')}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(game);
  }
  return [...grouped.entries()]
    .map(([key, members]) => buildFamily(key, members))
    .sort((left, right) => left.sortTitle.localeCompare(right.sortTitle) || left.id.localeCompare(right.id));
}

export function familyCatalogHash(families) {
  return hashObject({
    familySchemaVersion: GAME_FAMILY_SCHEMA_VERSION,
    families: families.map((family) => ({
      id: family.id,
      familyKey: family.familyKey,
      variantIds: family.variantIds,
      memberships: family.memberships,
      platformByTier: family.platformByTier,
      platforms: family.platforms,
      segment: family.segment
    }))
  });
}

function membershipGroups(items, field, keys) {
  const groups = Object.fromEntries(keys.map((key) => [key, []]));
  for (const item of items) {
    const values = Array.isArray(item[field]) ? item[field] : [item[field]];
    for (const value of values.filter(Boolean)) {
      groups[value].push(item.id);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, ids.sort()]));
}

function membershipDiffs(items) {
  const tierSets = Object.fromEntries(
    TIER_IDS.map((tierId) => [
      tierId,
      new Set(items.filter((item) => item.memberships.includes(tierId)).map((item) => item.id))
    ])
  );
  const difference = (left, right) => [...left].filter((id) => !right.has(id)).sort();
  return {
    premiumNotUltimate: difference(tierSets.premium, tierSets.ultimate),
    premiumNotEssential: difference(tierSets.premium, tierSets.essential),
    ultimateNotPremium: difference(tierSets.ultimate, tierSets.premium),
    essentialNotPremium: difference(tierSets.essential, tierSets.premium),
    essentialNotUltimate: difference(tierSets.essential, tierSets.ultimate),
    ultimateNotEssential: difference(tierSets.ultimate, tierSets.essential)
  };
}

export function buildMembershipSummary(items) {
  const segments = membershipGroups(items, 'segment', SEGMENT_IDS);
  const diffs = membershipDiffs(items);
  return {
    segments,
    diffs,
    counts: {
      total: items.length,
      tiers: Object.fromEntries(
        TIER_IDS.map((tierId) => [
          tierId,
          items.filter((item) => item.memberships.includes(tierId)).length
        ])
      ),
      platforms: Object.fromEntries(
        PLATFORM_IDS.map((platformId) => [
          platformId,
          items.filter((item) => item.platforms.includes(platformId)).length
        ])
      ),
      tierPlatforms: Object.fromEntries(
        TIER_IDS.map((tierId) => [
          tierId,
          Object.fromEntries(
            PLATFORM_IDS.map((platformId) => [
              platformId,
              items.filter((item) => item.platformByTier?.[tierId]?.includes(platformId)).length
            ])
          )
        ])
      ),
      segments: Object.fromEntries(
        Object.entries(segments).map(([segmentId, ids]) => [segmentId, ids.length])
      ),
      diffs: Object.fromEntries(
        Object.entries(diffs).map(([diffId, ids]) => [diffId, ids.length])
      )
    }
  };
}

export function buildFamilyCatalog(games) {
  const families = buildGameFamilies(games);
  const { segments, diffs, counts } = buildMembershipSummary(families);
  return {
    families,
    familyHash: familyCatalogHash(families),
    familySegments: segments,
    familyDiffs: diffs,
    familyCounts: counts
  };
}
