import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildCatalogSummary } from '../src/catalog-summary.mjs';
import { MAX_GAME_SCREENSHOTS, buildLeavingSoonUrl } from '../src/constants.mjs';
import { fetchLeavingSoonList, parseSiglsResponse } from '../src/fetch-sigls.mjs';
import {
  GAME_FAMILY_SCHEMA_VERSION,
  buildFamilyCatalog,
  gameFamilyId,
  gameFamilyKey,
  stripPlatformQualifier
} from '../src/game-families.mjs';
import { normalizeCatalog } from '../src/normalize-catalog.mjs';
import {
  backfillFamilyHistory,
  membershipOnlySnapshot,
  updateHistory
} from '../src/update-history.mjs';
import { validateCatalog } from '../src/validate-data.mjs';

const products = JSON.parse(await readFile(new URL('./fixtures/products.json', import.meta.url), 'utf8'));
const checkedInCurrent = JSON.parse(await readFile(new URL('../site/data/current.json', import.meta.url), 'utf8'));
const reportTemplate = await readFile(new URL('../src/report-template.html', import.meta.url), 'utf8');

function list(tier, platform, productIds) {
  return {
    tier,
    tierLabel: tier,
    platform,
    platformLabel: platform,
    siglId: `${tier}-sigl`,
    subscriptionContext: `${tier}-subscription`,
    platformContext: platform,
    url: `https://example.test/${tier}/${platform}`,
    title: 'All games',
    description: 'fixture',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    status: 'ok',
    sourceCount: productIds.length,
    count: productIds.length,
    productIds,
    sourceProductIds: productIds,
    swapsApplied: []
  };
}

function leavingList(platform, productIds) {
  const siglId = platform === 'console'
    ? '393f05bf-e596-4ef6-9487-6d4fa0eab987'
    : 'cc7fc951-d00f-410e-9e02-5e4628e04163';
  return {
    kind: 'leavingSoon',
    platform,
    platformLabel: platform,
    siglId,
    url: `https://example.test/leaving/${platform}`,
    title: 'Leaving soon',
    description: 'fixture',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    status: 'ok',
    sourceCount: productIds.length,
    count: productIds.length,
    productIds,
    sourceProductIds: productIds,
    swapsApplied: []
  };
}

function emptyLeavingSoonLists() {
  return [leavingList('console', []), leavingList('pc', [])];
}

function currentFromLists(lists, generatedAt, productMap = products, leavingSoonLists = emptyLeavingSoonLists()) {
  return normalizeCatalog({
    sigls: lists,
    leavingSoonLists,
    products: productMap,
    productSource: { endpoint: 'fixture' },
    generatedAt,
    market: 'FR',
    language: 'en-us'
  });
}

function productFixture(id, title) {
  const product = structuredClone(products.AAA);
  product.ProductId = id;
  product.LocalizedProperties[0].ProductTitle = title;
  return product;
}

function catalogWithProducts(entries, memberships, generatedAt) {
  const productMap = Object.fromEntries(entries.map(([id, title]) => [id, productFixture(id, title)]));
  const idsByPlatform = memberships.reduce((groups, membership) => {
    groups[membership.platform] ??= [];
    groups[membership.platform].push(membership);
    return groups;
  }, {});
  return currentFromLists([
    list('ultimate', 'console', (idsByPlatform.console ?? []).map(({ id }) => id)),
    list('ultimate', 'pc', (idsByPlatform.pc ?? []).map(({ id }) => id)),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ], generatedAt, productMap);
}

test('SIGLS parsing applies known product swaps', () => {
  const parsed = parseSiglsResponse([
    { siglId: 'fixture', title: 'All games' },
    { id: '9PNQKHFLD2WQ' }
  ]);
  assert.deepEqual(parsed.productIds, ['9PNJXVCVWD4K']);
  assert.deepEqual(parsed.swapsApplied, [{ from: '9PNQKHFLD2WQ', to: '9PNJXVCVWD4K' }]);
});

test('leaving-soon SIGLS fetching uses the platform collection and validates its identity', async () => {
  const url = buildLeavingSoonUrl({ platformId: 'console', market: 'FR', language: 'en-us' });
  assert.match(url, /^https:\/\/catalog\.gamepass\.com\/sigls\/v2\?/);
  assert.match(url, /id=393f05bf-e596-4ef6-9487-6d4fa0eab987/);
  const fetched = await fetchLeavingSoonList({
    platformId: 'console',
    market: 'FR',
    language: 'en-us',
    generatedAt: '2026-01-01T00:00:00.000Z',
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        { siglId: '393f05bf-e596-4ef6-9487-6d4fa0eab987', title: 'Leaving soon' },
        { id: 'AAA' }
      ]
    })
  });
  assert.deepEqual(fetched.productIds, ['AAA']);
  assert.equal(fetched.platform, 'console');

  await assert.rejects(
    fetchLeavingSoonList({
      platformId: 'console',
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ siglId: 'wrong-source', title: 'Leaving soon' }]
      })
    }),
    /source identity mismatch/
  );
});

test('normalizeCatalog computes tier segments and diffs without hierarchy assumptions', () => {
  const current = currentFromLists([
    list('ultimate', 'console', ['AAA', 'BBB']),
    list('ultimate', 'pc', ['AAA']),
    list('premium', 'console', ['AAA', 'CCC']),
    list('premium', 'pc', ['CCC']),
    list('essential', 'console', ['AAA']),
    list('essential', 'pc', [])
  ], '2026-01-01T00:00:00.000Z');

  assert.equal(current.counts.total, 3);
  assert.equal(current.counts.tiers.ultimate, 2);
  assert.equal(current.counts.tiers.premium, 2);
  assert.equal(current.counts.tiers.essential, 1);
  assert.deepEqual(current.segments.allTiers, ['AAA']);
  assert.deepEqual(current.segments.ultimateOnly, ['BBB']);
  assert.deepEqual(current.segments.premiumOnly, ['CCC']);
  assert.deepEqual(current.diffs.premiumNotUltimate, ['CCC']);
  assert.deepEqual(current.diffs.essentialNotPremium, []);
  assert.equal(current.games.find((game) => game.id === 'AAA').segment, 'allTiers');
});

test('normalizeCatalog builds resolvable Xbox store links', () => {
  const current = currentFromLists([
    list('ultimate', 'console', ['9PNJXVCVWD4K']),
    list('ultimate', 'pc', []),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ], '2026-01-01T00:00:00.000Z');

  assert.equal(
    current.games.find((game) => game.id === '9PNJXVCVWD4K').url,
    'https://www.xbox.com/en-us/games/store/forza-horizon-4/9PNJXVCVWD4K'
  );
});

test('normalizeCatalog enriches DisplayCatalog metadata with availability, PEGI, modes, dates, and descriptions', () => {
  const current = currentFromLists([
    list('ultimate', 'console', ['9PNJXVCVWD4K', 'BBB']),
    list('ultimate', 'pc', []),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ], '2026-01-01T00:00:00.000Z');

  const forza = current.games.find((game) => game.id === '9PNJXVCVWD4K');
  assert.equal(forza.availableInFR, true);
  assert.equal(forza.pegiRating, 'PEGI 3');
  assert.equal(forza.ratingSystem, 'PEGI');
  assert.equal(forza.ratingId, 'PEGI:3');
  assert.equal(forza.supportsSinglePlayer, true);
  assert.equal(forza.supportsMultiplayer, true);
  assert.equal(forza.supportsOnlineMultiplayer, true);
  assert.equal(forza.supportsLocalMultiplayer, false);
  assert.equal(forza.supportsCoop, true);
  assert.equal(forza.supportsOnlineCoop, true);
  assert.equal(forza.supportsLocalCoop, true);
  assert.deepEqual(forza.playerModes, [
    'Single player',
    'Online co-op (2-6)',
    'Local co-op (2)',
    'Online multiplayer (2-1000)'
  ]);
  assert.equal(forza.releaseDate, '2018-10-01');
  assert.equal(forza.shortDescription, 'Drive across Britain.');
  assert.equal('fullDescription' in forza, false);
  assert.equal(forza.description, 'Drive across Britain.');
  assert.deepEqual(forza.screenshots, [
    'https://store-images.s-microsoft.com/image/shot-a?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-b?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-c?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-d?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-e?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-f?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-g?w=640&h=360&q=80&format=jpg',
    'https://store-images.s-microsoft.com/image/shot-h?w=640&h=360&q=80&format=jpg'
  ]);

  const bravo = current.games.find((game) => game.id === 'BBB');
  assert.equal(bravo.availableInFR, false);
  assert.equal(bravo.pegiRating, null);
  assert.deepEqual(bravo.playerModes, []);
  assert.equal(bravo.supportsSinglePlayer, false);
  assert.equal(bravo.supportsMultiplayer, false);
  assert.equal(bravo.supportsCoop, false);
  assert.deepEqual(bravo.screenshots, []);
});

test('normalizeCatalog annotates official leaving-soon platforms and warns about unmatched IDs', () => {
  const current = currentFromLists([
    list('ultimate', 'console', ['AAA', 'BBB']),
    list('ultimate', 'pc', ['AAA', 'BBB']),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ], '2026-01-01T00:00:00.000Z', products, [
    leavingList('console', ['AAA', 'MISSING']),
    leavingList('pc', ['AAA', 'BBB'])
  ]);

  assert.deepEqual(current.leavingSoon, {
    all: ['AAA', 'BBB'],
    console: ['AAA'],
    pc: ['AAA', 'BBB'],
    unmatched: {
      console: ['MISSING'],
      pc: []
    }
  });
  assert.deepEqual(current.games.find((game) => game.id === 'AAA').leavingSoonPlatforms, ['console', 'pc']);
  assert.equal(current.games.find((game) => game.id === 'BBB').leavingSoon, true);
  assert.equal(current.counts.leavingSoon, 2);
  assert.deepEqual(current.counts.leavingSoonPlatforms, { console: 1, pc: 2 });
  const validation = validateCatalog({ current });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.warnings.filter((warning) => warning.includes('leaving-soon product IDs')).length, 1);
  assert.match(validation.warnings.join('\n'), /1 leaving-soon product IDs/);
});

test('game family keys normalize only conservative title differences', () => {
  const equivalentPairs = [
    ['Assassin’s Creed Syndicate', "Assassin's Creed Syndicate"],
    ['Avatar: Frontiers of Pandora™', 'Avatar - Frontiers of Pandora'],
    ['Battlefield™ 1 Revolution', 'Battlefield 1 Revolution'],
    ['Battlefield™ II Revolution', 'Battlefield 2 Revolution'],
    ['Commandos: Origins', 'Commandos: Origins (Win)'],
    ['Watch Dogs2', 'Watch Dogs II'],
    ['Example Game', 'Example Game - Windows + Launcher'],
    ['Example Game', 'Example Game - Win'],
    ['Example Game', 'Example Game – Windows'],
    ['Example Game', 'Example Game Xbox Series X|S'],
    ['Example Game', 'Example Game PC Version']
  ];
  for (const [left, right] of equivalentPairs) {
    assert.equal(gameFamilyKey(left), gameFamilyKey(right), `${left} should match ${right}`);
  }

  const distinctPairs = [
    ['Football Manager 26', 'Football Manager 26 Console'],
    ['Control', 'Control Ultimate Edition'],
    ['Oblivion', 'Oblivion Remastered'],
    ['Resident Evil 4', 'Resident Evil 4 Remake'],
    ['Halo Infinite', 'Halo Infinite Campaign Bundle'],
    ['Cities: Skylines', 'Cities: Skylines Xbox One Edition']
  ];
  for (const [left, right] of distinctPairs) {
    assert.notEqual(gameFamilyKey(left), gameFamilyKey(right), `${left} should remain separate from ${right}`);
  }

  const key = gameFamilyKey('Commandos: Origins (Win)');
  assert.equal(stripPlatformQualifier('Example Game – Windows'), 'Example Game');
  assert.equal(gameFamilyId(key), gameFamilyId(key));
  assert.match(gameFamilyId(key), /^family-[a-f0-9]{64}$/);
});

test('family aggregation preserves variants and unions membership metadata', () => {
  const base = {
    publisher: 'Publisher',
    developer: 'Developer',
    genres: [],
    playerModes: [],
    screenshots: [],
    availableInFR: true,
    leavingSoon: false,
    leavingSoonPlatforms: [],
    supportsSinglePlayer: false,
    supportsMultiplayer: false,
    supportsOnlineMultiplayer: false,
    supportsLocalMultiplayer: false,
    supportsCoop: false,
    supportsOnlineCoop: false,
    supportsLocalCoop: false
  };
  const games = [
    {
      ...base,
      id: 'CONSOLE',
      title: 'Commandos: Origins',
      url: 'https://www.xbox.com/games/store/commandos-origins/CONSOLE',
      memberships: ['ultimate'],
      platforms: ['console'],
      platformByTier: { ultimate: ['console'] },
      segment: 'ultimateOnly',
      genres: ['Strategy'],
      releaseDate: '2025-04-09',
      leavingSoon: true,
      leavingSoonPlatforms: ['console'],
      supportsSinglePlayer: true
    },
    {
      ...base,
      id: 'PC',
      title: 'Commandos: Origins (Win)',
      url: 'https://www.xbox.com/games/store/commandos-origins-win/PC',
      memberships: ['premium'],
      platforms: ['pc'],
      platformByTier: { premium: ['pc'] },
      segment: 'premiumOnly',
      genres: ['Simulation'],
      releaseDate: '9998-12-31',
      leavingSoon: true,
      leavingSoonPlatforms: ['pc'],
      supportsOnlineCoop: true,
      supportsCoop: true
    },
    {
      ...base,
      id: 'PC-ALT',
      title: 'Commandos: Origins PC',
      url: 'https://www.xbox.com/games/store/commandos-origins-pc/PC-ALT',
      memberships: ['ultimate'],
      platforms: ['pc'],
      platformByTier: { ultimate: ['pc'] },
      segment: 'ultimateOnly'
    }
  ];

  const catalog = buildFamilyCatalog(games);
  assert.equal(catalog.families.length, 1);
  const [family] = catalog.families;
  assert.equal(family.title, 'Commandos: Origins');
  assert.equal(family.variantCount, 3);
  assert.deepEqual(new Set(family.variantIds), new Set(['CONSOLE', 'PC', 'PC-ALT']));
  assert.deepEqual(family.memberships, ['ultimate', 'premium']);
  assert.deepEqual(family.platformByTier, {
    ultimate: ['console', 'pc'],
    premium: ['pc']
  });
  assert.deepEqual(family.platforms, ['console', 'pc']);
  assert.equal(family.leavingSoon, true);
  assert.deepEqual(family.leavingSoonPlatforms, ['console', 'pc']);
  assert.deepEqual(family.genres, ['Simulation', 'Strategy']);
  assert.equal(family.releaseDate, '2025-04-09');
  assert.equal(family.supportsSinglePlayer, true);
  assert.equal(family.supportsCoop, true);
  assert.equal(catalog.familyCounts.total, 1);
});

test('checked-in catalog family references preserve every Xbox URL', () => {
  const productsById = new Map(checkedInCurrent.games.map((game) => [game.id, game]));

  assert.equal(checkedInCurrent.games.length, checkedInCurrent.counts.total);
  assert.equal(checkedInCurrent.families.length, checkedInCurrent.familyCounts.total);
  assert.equal(checkedInCurrent.metadata.familyGrouping.schemaVersion, GAME_FAMILY_SCHEMA_VERSION);
  assert.equal(
    checkedInCurrent.metadata.familyGrouping.collapsedProductCount,
    checkedInCurrent.games.length - checkedInCurrent.families.length
  );

  for (const family of checkedInCurrent.families) {
    assert.equal(family.variantCount, family.variantIds.length);
    for (const productId of family.variantIds) {
      const product = productsById.get(productId);
      assert(product, `missing product ${productId}`);
      assert.match(product.url, new RegExp(`/${productId}$`));
    }
  }

  assert.match(reportTemplate, /<details class="variant-links">/);
  assert.match(reportTemplate, /<summary>Open on Xbox<\/summary>/);
  assert.match(reportTemplate, /<a class="xbox-link" href="\$\{escapeHtml\(variants\[0\]\.url\)\}">Open on Xbox<\/a>/);
  assert.match(reportTemplate, /<a href="\$\{escapeHtml\(variant\.url\)\}">\$\{escapeHtml\(variant\.title\)\}<\/a>/);
  assert.doesNotMatch(reportTemplate, /variant-link-meta|Product ID \$\{escapeHtml\(variant\.id\)\}/);
  assert.match(reportTemplate, /resultsSummary\.textContent = `\$\{rows\.length\.toLocaleString\(\)\} of \$\{sourceRows\.length\.toLocaleString\(\)\} games`/);
  assert.doesNotMatch(reportTemplate, /listingCount|\['Product listings', app\.current\.counts\.total\]/);
  assert.match(reportTemplate, /variantText = variantsFor\(game\)/);
  assert.match(reportTemplate, /id="leavingStatus"/);
  assert.match(reportTemplate, /class="badge leaving-soon"/);
  assert.match(reportTemplate, /<th scope="col">Leaving<\/th>/);
});

test('card genres render as accented chips above the publisher line', () => {
  const cardStart = reportTemplate.indexOf('function renderCard(game)');
  const cardEnd = reportTemplate.indexOf('function renderTableRow(game)', cardStart);
  assert(cardStart >= 0 && cardEnd > cardStart, 'renderCard should exist before renderTableRow');
  const cardSource = reportTemplate.slice(cardStart, cardEnd);

  const genrePosition = cardSource.indexOf('${cardGenres(game)}');
  const publisherPosition = cardSource.indexOf('game.publisher');
  assert(genrePosition >= 0, 'card should render genre chips');
  assert(genrePosition < publisherPosition, 'genre chips should appear before the publisher line');
  assert.doesNotMatch(cardSource, /game\.genres \?\? \[\]\)\.slice\(0, 3\)\.join/);

  assert.match(reportTemplate, /class="chip-genre"/);
  assert.match(reportTemplate, /--accent-3:/);
  assert.match(reportTemplate, /<td class="genre-col">\$\{genreChipList\(game\.genres \?\? \[\]\)\}<\/td>/);
});

test('game card renders leaving soon overlay on the card media instead of in card body', () => {
  const cardStart = reportTemplate.indexOf('function renderCard(game)');
  const cardEnd = reportTemplate.indexOf('function renderTableRow(game)', cardStart);
  assert(cardStart >= 0 && cardEnd > cardStart, 'renderCard should exist before renderTableRow');
  const cardSource = reportTemplate.slice(cardStart, cardEnd);

  assert.match(cardSource, /class="card-media"/);
  assert.match(cardSource, /\$\{leavingSoonCardOverlay\(game\)\}/);
  assert.doesNotMatch(cardSource, /<div class="card-body">[\s\S]*\$\{leavingSoonBadge\(game\)\}/);

  assert.match(reportTemplate, /function leavingSoonCardOverlay\(game\)/);
  assert.match(reportTemplate, /class="card-leaving-ribbon"/);
  assert.doesNotMatch(reportTemplate, /class="card-leaving-macaron"/);
  assert.doesNotMatch(reportTemplate, /class="card-leaving-flag"/);
  assert.doesNotMatch(reportTemplate, /id="leavingStyleButton"/);
  assert.doesNotMatch(reportTemplate, /id="toolbarLeavingStyle"/);
});

test('recommendation UI keeps taste state local and independent of catalog filters', () => {
  assert.match(reportTemplate, /id="recommendationsPanel"/);
  assert.match(reportTemplate, /id="recommendationTeaser"/);
  assert.match(reportTemplate, /id="recommendationsDrawer" class="recommendations-drawer hidden" role="dialog" aria-modal="true" aria-labelledby="recommendationsDrawerTitle" aria-describedby="recommendationSummary" aria-hidden="true" tabindex="-1" inert/);
  assert.match(reportTemplate, /id="toolbarRecommendationsButton"/);
  assert.match(reportTemplate, /id="recommendationsSeeAllButton"/);
  assert.match(reportTemplate, /id="tasteControls"/);
  assert.match(reportTemplate, /catabox\.taste\.v1/);
  assert.match(reportTemplate, /localStorage\.setItem\(TASTE_STORAGE_KEY/);
  assert.match(reportTemplate, /loadJson\('data\/recommendations\.json', false, controller\.signal\)/);
  assert.match(reportTemplate, /async function loadOptionalRecommendations\(\)/);
  assert.match(reportTemplate, /function recommendationArtifactIssue\(artifact\)/);
  assert.match(reportTemplate, /artifact\.schemaVersion !== RECOMMENDATION_SCHEMA_VERSION/);
  assert.match(reportTemplate, /artifact\.algorithm !== RECOMMENDATION_ALGORITHM/);
  assert.match(reportTemplate, /artifact\.generatedAt !== app\.current\.generatedAt/);
  assert.match(reportTemplate, /artifact\.catalogHash !== app\.current\.catalogHash/);
  assert.match(reportTemplate, /artifact\.familyHash !== app\.current\.familyHash/);
  assert.match(reportTemplate, /candidate\.score < 0/);
  assert.match(reportTemplate, /candidate\.score > 1/);
  assert.match(reportTemplate, /candidate\.reasons\.length === 0/);
  assert.match(reportTemplate, /seen\.has\(candidate\.id\)/);
  assert.match(reportTemplate, /const \[current, historyData, statusData\] = await Promise\.all/);
  assert.match(reportTemplate, /void hydrateRecommendations\(\)/);
  assert.match(reportTemplate, /function renderRecommendations\(\)/);
  assert.match(reportTemplate, /recommendationRailHtml\(rails\[0\], rails\[0\]\.items\.slice\(0, 4\), \{ compact: true \}\)/);
  assert.match(reportTemplate, /observeLazyImages\(\[recommendationTeaser, recommendationRails\]\)/);
  assert.match(reportTemplate, /class="recommendation-card\$\{compact \? ' recommendation-card-teaser' : ''\}" data-preview-game="\$\{escapeHtml\(game\.id\)\}"/);
  assert.match(reportTemplate, /class="recommendation-card\$\{compact \? ' recommendation-card-teaser' : ''\}"[\s\S]*class="card-media"[\s\S]*\$\{leavingSoonCardOverlay\(game\)\}/);
  assert.match(reportTemplate, /<h4>\$\{escapeHtml\(game\.title\)\}<\/h4>\s+\$\{cardGenres\(game\)\}/);
  assert.doesNotMatch(reportTemplate, /class="recommendation-card-body"[\s\S]*\$\{leavingSoonBadge\(game\)\}/);
  assert.match(reportTemplate, /for \(const container of \[recommendationTeaser, recommendationRails, cards, tableBody\]\)/);
  assert.doesNotMatch(reportTemplate, /function recommendationMatchesFilters/);
  const rankedStart = reportTemplate.indexOf('function rankedRecommendationCandidates()');
  const rankedEnd = reportTemplate.indexOf('function latestTasteAnchor()', rankedStart);
  assert(rankedStart >= 0 && rankedEnd > rankedStart, 'ranked recommendation candidates should exist');
  const rankedSource = reportTemplate.slice(rankedStart, rankedEnd);
  assert.doesNotMatch(rankedSource, /matchesFilters|selectedValues|allRowsForState/);
  const anchorStart = reportTemplate.indexOf('function rankedAnchorCandidates(sourceId)');
  const anchorEnd = reportTemplate.indexOf('function preferenceReasons(game, artifact = null)', anchorStart);
  assert(anchorStart >= 0 && anchorEnd > anchorStart, 'anchor recommendation candidates should exist');
  const anchorSource = reportTemplate.slice(anchorStart, anchorEnd);
  assert.doesNotMatch(anchorSource, /matchesFilters|selectedValues|allRowsForState/);
  assert.match(reportTemplate, /function rankedAnchorCandidates\(sourceId\)/);
  assert.match(reportTemplate, /function restoreRecommendationFocus\(action, preferredGameIds, container = recommendationRails\)/);
  assert.match(reportTemplate, /function openRecommendationsDrawer\(/);
  assert.match(reportTemplate, /function closeRecommendationsDrawer\(/);
  assert.match(reportTemplate, /function trapDialogFocus\(event, dialog, fallback\)/);
  assert.match(reportTemplate, /if \(!focusable\.includes\(document\.activeElement\)\)/);
  assert.match(reportTemplate, /setTimeout\(\(\) => recommendationsDrawer\.focus\(\{ preventScroll: true \}\), delay\)/);
  assert.match(reportTemplate, /history\.pushState\(\{ \.\.\.history\.state, cataboxRecommendations: true \}, ''\)/);
  assert.match(reportTemplate, /mobileQuery\.addEventListener\('change'/);
  assert.match(reportTemplate, /width: min\(75vw, 1440px\)/);
  assert.match(reportTemplate, /id="recommendationsDrawerResizer"/);
  assert.match(reportTemplate, /id="recommendationsDrawerCount"/);
  assert.match(reportTemplate, /id="recommendationsDrawerContext"/);
  assert.match(reportTemplate, /class="recommendations-drawer-mark"/);
  assert.match(reportTemplate, /class="recommendations-drawer-mark recommendations-inline-mark"/);
  assert.match(reportTemplate, /\.recommendations-drawer-mark\.recommendations-inline-mark\s*\{\s*grid-area: auto;/);
  assert.match(reportTemplate, /class="recommendations-actions recommendations-drawer-actions"/);
  assert.match(reportTemplate, /id="tasteToggleLabel"/);
  assert.match(reportTemplate, /id="tasteQuickEntryLabel"/);
  assert.match(reportTemplate, /recommendationsDrawerCount\.textContent = disabled \? 'No matches'/);
  assert.match(reportTemplate, /function setRecommendationDrawerWidth\(width, \{ persist = false \} = \{\}\)/);
  assert.match(reportTemplate, /recommendationsDrawerResizer\.addEventListener\('pointerdown'/);
  assert.match(reportTemplate, /recommendationsDrawerResizer\.addEventListener\('keydown'/);
  assert.match(reportTemplate, /grid-template-columns: repeat\(auto-fit, minmax\(240px, 1fr\)\)/);
  assert.match(reportTemplate, /recommendationRailHtml\(rail, rail\.items, \{ dense: !mobileQuery\.matches \}\)/);
  assert.match(reportTemplate, /aria-label="Close recommendations"/);
  assert.match(reportTemplate, /transform: translateY\(100%\)/);
  assert.match(reportTemplate, /\.recommendation-teaser \{\s+max-height: 300px/);
  assert.match(reportTemplate, /\.recommendation-card-teaser \.card-media \{\s+height: 92px/);
  assert.match(reportTemplate, /data-taste-action=/);
  assert.match(reportTemplate, /visible: '👍'/);
  assert.match(reportTemplate, /visible: '👎'/);
  assert.match(reportTemplate, /visible: '🔖 Save for later'/);
  assert.match(reportTemplate, /visible: '✓ Played it'/);
  assert.match(reportTemplate, /aria-label="\$\{escapeHtml\(`\$\{label\}: \$\{game\.title\}`\)\}"/);
  assert.match(reportTemplate, /Similar themes and description/);
  assert.match(reportTemplate, /function recommendationEmptyMessage\(\)/);
  assert.match(reportTemplate, /No current games are available to recommend/);
  assert.match(reportTemplate, /Every tracked game is already liked, disliked, saved, or marked played/);
});

test('every catalog card and table row exposes the full taste action row', () => {
  assert.match(reportTemplate, /function tasteActionRow\(game, \{ compact = false \} = \{\}\)/);
  assert.doesNotMatch(reportTemplate, /tasteSeedButton/);
  assert.doesNotMatch(reportTemplate, /taste-seed-button/);

  const cardStart = reportTemplate.indexOf('function renderCard(game)');
  const cardEnd = reportTemplate.indexOf('function renderTableRow(game)', cardStart);
  const rowEnd = reportTemplate.indexOf('function findGameById(familyId)', cardEnd);
  assert(cardStart >= 0 && cardEnd > cardStart && rowEnd > cardEnd, 'card and row renderers should exist in order');

  assert.match(reportTemplate.slice(cardStart, cardEnd), /\$\{tasteActionRow\(game\)\}/);
  assert.match(reportTemplate.slice(cardEnd, rowEnd), /\$\{tasteActionRow\(game, \{ compact: true \}\)\}/);

  assert.match(reportTemplate, /const TASTE_GAME_ACTIONS = \['liked', 'disliked', 'saved', 'played'\]/);
  assert.match(reportTemplate, /const TASTE_DEPARTED_ACTIONS = \['saved', 'played'\]/);
  assert.match(reportTemplate, /return game\.departed \? TASTE_DEPARTED_ACTIONS : TASTE_GAME_ACTIONS/);
  assert.match(reportTemplate, /icon: '🔖'/);
  assert.match(reportTemplate, /icon: '✓'/);
  assert.match(reportTemplate, /const glyph = compact \? copy\.icon \?\? copy\.visible : copy\.visible/);
  assert.match(reportTemplate, /button\.setAttribute\('aria-label', `\$\{label\}: \$\{button\.dataset\.gameTitle\}`\)/);
});

test('quick entry marks played games outside the active filters', () => {
  assert.match(reportTemplate, /id="tasteQuickEntryButton"/);
  assert.match(reportTemplate, /id="tasteQuickEntry"/);
  assert.match(reportTemplate, /id="tasteQuickEntrySearch"/);
  assert.match(reportTemplate, /id="tasteQuickEntryResults"/);
  assert.match(reportTemplate, /id="tasteQuickEntryCount" class="quick-entry-count" aria-live="polite"/);
  assert.match(reportTemplate, /id="tasteQuickEntryRecent"/);
  assert.match(reportTemplate, /aria-expanded="false" aria-controls="tasteQuickEntry"/);

  assert.match(reportTemplate, /app\.quickEntryIndex = \[\.\.\.currentFamilies\(\), \.\.\.departedRows\(\)\]/);
  assert.match(reportTemplate, /if \(needle\.length < QUICK_ENTRY_MIN_QUERY\) return \[\]/);
  assert.match(reportTemplate, /\.slice\(0, QUICK_ENTRY_RESULT_LIMIT\)/);
  assert.match(reportTemplate, /function quickEntryMarkPlayed\(game\)/);
  assert.match(reportTemplate, /if \(app\.taste\.played\.includes\(game\.id\)\)/);
  assert.match(reportTemplate, /if \(event\.key !== 'Enter'\) return;/);
  assert.match(reportTemplate, /quickEntryMarkPlayed\(target\)/);
  assert.match(reportTemplate, /data-quick-entry-undo="true"/);
  assert.match(reportTemplate, /tasteQuickEntry\.addEventListener\('click'/);

  const matchStart = reportTemplate.indexOf('function quickEntryMatches(query)');
  const matchEnd = reportTemplate.indexOf('function quickEntryResultHtml(game)', matchStart);
  assert(matchStart >= 0 && matchEnd > matchStart, 'quick entry search should exist');
  const matchSource = reportTemplate.slice(matchStart, matchEnd);
  assert.doesNotMatch(matchSource, /matchesFilters/, 'quick entry search must ignore the active catalog filters');
  assert.doesNotMatch(matchSource, /allRowsForState/, 'quick entry search must ignore the catalog state filter');
});

test('hover preview exposes player mode, platform, and tier tags', () => {
  assert.match(reportTemplate, /function previewTagsHtml\(game\)/);

  const tagStart = reportTemplate.indexOf('function previewTagsHtml(game)');
  const tagEnd = reportTemplate.indexOf('function previewScreenshots', tagStart);
  assert(tagStart >= 0 && tagEnd > tagStart, 'preview tag helper should exist before previewScreenshots');
  const tagSource = reportTemplate.slice(tagStart, tagEnd);

  assert.match(tagSource, /playerModeLabels\(game\)/);
  assert.match(tagSource, /labelFor\('platforms', platform\)/);
  assert.match(tagSource, /labelFor\('tiers', tier\)/);
  assert.match(tagSource, /class="chip chip-mode"/);
  assert.match(tagSource, /No player mode metadata/);

  const previewStart = tagSource.indexOf('function previewHtml(game)');
  assert(previewStart >= 0, 'previewHtml should follow previewTagsHtml');
  const previewSource = tagSource.slice(previewStart);
  const tagPosition = previewSource.indexOf('${previewTagsHtml(game)}');
  const descriptionPosition = previewSource.indexOf('id="gamePreviewDescription"');
  assert(tagPosition >= 0, 'preview should render the tag chips');
  assert(tagPosition < descriptionPosition, 'tags should sit between the title and the description');

  assert.match(reportTemplate, /\.chip-mode \{/);
  assert.match(reportTemplate, /\.game-preview-tags \{/);
});

test('screenshot metadata does not affect the membership catalog hash', () => {
  const lists = [
    list('ultimate', 'console', ['9PNJXVCVWD4K']),
    list('ultimate', 'pc', []),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ];
  const current = currentFromLists(lists, '2026-01-01T00:00:00.000Z');
  const changedProducts = structuredClone(products);
  changedProducts['9PNJXVCVWD4K'].LocalizedProperties[0].Images[1].Uri = '//store-images.s-microsoft.com/image/replaced-shot';
  const changed = currentFromLists(lists, '2026-01-01T00:00:00.000Z', changedProducts);
  const leavingChanged = currentFromLists(
    lists,
    '2026-01-01T00:00:00.000Z',
    products,
    [leavingList('console', ['9PNJXVCVWD4K']), leavingList('pc', [])]
  );

  assert.equal(changed.catalogHash, current.catalogHash);
  assert.equal(changed.familyHash, current.familyHash);
  assert.equal(leavingChanged.catalogHash, current.catalogHash);
  assert.equal(leavingChanged.familyHash, current.familyHash);
  assert.notDeepEqual(changed.games[0].screenshots, current.games[0].screenshots);
});

test('preview slideshow starts each frame delay after the displayed image is ready', async () => {
  const loaderStart = reportTemplate.indexOf('function loadPreviewFrameElement');
  const loaderEnd = reportTemplate.indexOf('function previewImageFingerprint', loaderStart);
  const scheduleStart = reportTemplate.indexOf('function schedulePreviewAdvanceAfterPaint');
  const advanceStart = reportTemplate.indexOf('function advancePreviewFrame');
  const initialStart = reportTemplate.indexOf('function loadInitialPreviewFrame');
  const initialEnd = reportTemplate.indexOf('function placeGamePreview');
  assert(loaderStart >= 0 && loaderEnd > loaderStart);
  assert(scheduleStart >= 0 && advanceStart > scheduleStart);
  assert(initialStart > advanceStart && initialEnd > initialStart);

  const loadPreviewFrameElement = Function(
    `"use strict"; return (${reportTemplate.slice(loaderStart, loaderEnd).trim()});`
  )();
  const listeners = new Map();
  let resolveDecode;
  const frame = {
    complete: false,
    naturalWidth: 0,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    decode() {
      return new Promise((resolve) => {
        resolveDecode = resolve;
      });
    }
  };
  let ready = false;
  loadPreviewFrameElement(frame, 'https://example.test/frame.jpg', 'auto', () => {
    ready = true;
  }, assert.fail);
  assert.equal(ready, false);
  frame.complete = true;
  frame.naturalWidth = 1920;
  listeners.get('load')();
  assert.equal(ready, false);
  resolveDecode();
  await Promise.resolve();
  assert.equal(ready, true);
  assert.equal(listeners.size, 0);

  const animationFrames = [];
  const scheduledGenerations = [];
  const schedulePreviewAdvanceAfterPaint = Function(
    'requestAnimationFrame',
    'schedulePreviewAdvance',
    `"use strict"; return (${reportTemplate.slice(scheduleStart, advanceStart).trim()});`
  )(
    (callback) => animationFrames.push(callback),
    (generation) => scheduledGenerations.push(generation)
  );
  schedulePreviewAdvanceAfterPaint(7);
  assert.deepEqual(scheduledGenerations, []);
  animationFrames.shift()();
  assert.deepEqual(scheduledGenerations, []);
  animationFrames.shift()();
  assert.deepEqual(scheduledGenerations, [7]);

  const advanceSource = reportTemplate.slice(advanceStart, initialStart);
  const initialSource = reportTemplate.slice(initialStart, initialEnd);
  assert.match(advanceSource, /loadPreviewFrameElement\(incoming, candidate\.url, 'auto'/);
  assert.match(advanceSource, /schedulePreviewAdvanceAfterPaint\(generation\)/);
  assert.match(initialSource, /loadPreviewFrameElement\(frame, url, 'high'/);
  assert.match(initialSource, /schedulePreviewAdvanceAfterPaint\(generation\)/);
  assert.doesNotMatch(advanceSource, /incoming\.src = candidate\.url/);
});

test('validateCatalog rejects malformed screenshot arrays and accepts legacy missing fields', () => {
  const lists = [
    list('ultimate', 'console', ['9PNJXVCVWD4K']),
    list('ultimate', 'pc', []),
    list('premium', 'console', []),
    list('premium', 'pc', []),
    list('essential', 'console', []),
    list('essential', 'pc', [])
  ];
  const valid = currentFromLists(lists, '2026-01-01T00:00:00.000Z');

  const legacy = structuredClone(valid);
  delete legacy.games[0].screenshots;
  assert.deepEqual(validateCatalog({ current: legacy }).errors, []);

  const invalidCases = [
    {
      screenshots: 'https://example.test/shot.jpg',
      error: /invalid screenshots: expected string array/
    },
    {
      screenshots: [42],
      error: /invalid screenshot: expected absolute HTTPS URL/
    },
    {
      screenshots: ['not a URL'],
      error: /invalid screenshot URL/
    },
    {
      screenshots: ['http://example.test/shot.jpg'],
      error: /invalid screenshot URL protocol/
    },
    {
      screenshots: ['https://example.test/shot.jpg', 'https://example.test/shot.jpg'],
      error: /duplicate screenshot URL/
    },
    {
      screenshots: Array.from({ length: MAX_GAME_SCREENSHOTS + 1 }, (_, index) => `https://example.test/shot-${index}.jpg`),
      error: new RegExp(`expected at most ${MAX_GAME_SCREENSHOTS}`)
    }
  ];

  for (const invalidCase of invalidCases) {
    const current = structuredClone(valid);
    current.games[0].screenshots = invalidCase.screenshots;
    assert.match(validateCatalog({ current }).errors.join('\n'), invalidCase.error);
  }
});

test('history baseline is not treated as new, later runs track observed changes', () => {
  const first = currentFromLists([
    list('ultimate', 'console', ['AAA', 'BBB']),
    list('ultimate', 'pc', ['AAA']),
    list('premium', 'console', ['AAA', 'CCC']),
    list('premium', 'pc', ['CCC']),
    list('essential', 'console', ['AAA']),
    list('essential', 'pc', [])
  ], '2026-01-01T00:00:00.000Z');

  const baseline = updateHistory({ current: first, generatedAt: first.generatedAt });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.events.length, 0);
  assert.equal(baseline.history.games.AAA.firstObservedSource, 'baseline');
  assert.equal(baseline.history.games.AAA.addedAt, null);

  const second = currentFromLists([
    list('ultimate', 'console', ['AAA']),
    list('ultimate', 'pc', ['AAA']),
    list('premium', 'console', ['AAA', 'BBB', 'DDD']),
    list('premium', 'pc', ['AAA', 'DDD']),
    list('essential', 'console', ['AAA']),
    list('essential', 'pc', [])
  ], '2026-01-08T00:00:00.000Z');
  const observed = updateHistory({
    previousHistory: baseline.history,
    current: second,
    generatedAt: second.generatedAt
  });

  const eventTypes = observed.events.map((event) => event.type).sort();
  assert(eventTypes.includes('added'));
  assert(eventTypes.includes('removed'));
  assert(eventTypes.includes('tier_added'));
  assert(eventTypes.includes('tier_removed'));
  assert(eventTypes.includes('platform_added'));
  assert(eventTypes.includes('platform_removed'));
  assert.equal(observed.history.games.DDD.addedAt, '2026-01-08T00:00:00.000Z');
  assert.equal(observed.history.games.CCC.active, false);
  assert.equal(observed.history.games.BBB.lastTierChangedAt, '2026-01-08T00:00:00.000Z');
  assert.equal(observed.changed, true);
});

test('same-family SKU replacement stays visible only in product history', () => {
  const first = catalogWithProducts(
    [['SKU-OLD', 'Same Game']],
    [{ id: 'SKU-OLD', platform: 'console' }],
    '2026-02-01T00:00:00.000Z'
  );
  const baseline = updateHistory({ current: first, generatedAt: first.generatedAt });
  const second = catalogWithProducts(
    [['SKU-NEW', 'Same Game']],
    [{ id: 'SKU-NEW', platform: 'console' }],
    '2026-02-08T00:00:00.000Z'
  );
  const observed = updateHistory({
    previousHistory: baseline.history,
    current: second,
    generatedAt: second.generatedAt
  });

  assert.deepEqual(observed.productEvents.map((event) => event.type).sort(), ['added', 'removed']);
  assert.deepEqual(observed.familyEvents, []);
  const familyId = second.families[0].id;
  assert.deepEqual(observed.history.families[familyId].variantIds, ['SKU-NEW']);
  assert.deepEqual(observed.history.families[familyId].allVariantIds, ['SKU-NEW', 'SKU-OLD']);
  assert.equal(observed.history.observations.at(-1).familyChanged, false);
  assert.equal(observed.history.observations.at(-1).productChanged, true);
});

test('family history reacts only to aggregate variant membership changes', () => {
  const first = catalogWithProducts(
    [['CONSOLE', 'Shared Game'], ['PC', 'Shared Game (Win)']],
    [
      { id: 'CONSOLE', platform: 'console' },
      { id: 'PC', platform: 'pc' }
    ],
    '2026-03-01T00:00:00.000Z'
  );
  const baseline = updateHistory({ current: first, generatedAt: first.generatedAt });
  const consoleOnly = catalogWithProducts(
    [['CONSOLE', 'Shared Game']],
    [{ id: 'CONSOLE', platform: 'console' }],
    '2026-03-08T00:00:00.000Z'
  );
  const oneVariantLost = updateHistory({
    previousHistory: baseline.history,
    current: consoleOnly,
    generatedAt: consoleOnly.generatedAt
  });

  assert(oneVariantLost.familyEvents.some((event) => event.type === 'platform_removed' && event.platform === 'pc'));
  assert(!oneVariantLost.familyEvents.some((event) => ['added', 'removed'].includes(event.type)));

  const empty = catalogWithProducts([], [], '2026-03-15T00:00:00.000Z');
  const finalVariantLost = updateHistory({
    previousHistory: oneVariantLost.history,
    current: empty,
    generatedAt: empty.generatedAt
  });
  assert.equal(finalVariantLost.familyEvents.filter((event) => event.type === 'removed').length, 1);
});

test('legacy snapshots backfill family history without false additions', () => {
  const first = catalogWithProducts(
    [['SKU-OLD', 'Same Game']],
    [{ id: 'SKU-OLD', platform: 'console' }],
    '2026-04-01T00:00:00.000Z'
  );
  const baseline = updateHistory({ current: first, generatedAt: first.generatedAt });
  const second = catalogWithProducts(
    [['SKU-NEW', 'Same Game']],
    [{ id: 'SKU-NEW', platform: 'console' }],
    '2026-04-08T00:00:00.000Z'
  );
  const observed = updateHistory({
    previousHistory: baseline.history,
    current: second,
    generatedAt: second.generatedAt
  });
  const legacyHistory = structuredClone(observed.history);
  delete legacyHistory.families;
  delete legacyHistory.familyEvents;
  delete legacyHistory.familyHash;
  delete legacyHistory.familySchemaVersion;
  for (const observation of legacyHistory.observations) {
    observation.total = observation.productTotal;
    observation.counts = observation.productCounts;
    observation.eventCounts = observation.productEventCounts;
    delete observation.familyTotal;
    delete observation.familyCounts;
    delete observation.familyEventCounts;
    delete observation.familyHash;
  }
  for (const snapshotEntry of legacyHistory.snapshots) {
    snapshotEntry.total = snapshotEntry.productTotal;
    delete snapshotEntry.familyTotal;
    delete snapshotEntry.productTotal;
    delete snapshotEntry.familyHash;
    delete snapshotEntry.familyCounts;
    delete snapshotEntry.productCounts;
  }
  const legacySnapshots = [
    membershipOnlySnapshot(first, first.generatedAt),
    membershipOnlySnapshot(second, second.generatedAt)
  ].map((snapshot) => {
    delete snapshot.families;
    delete snapshot.familyHash;
    delete snapshot.familyCounts;
    delete snapshot.familyTotal;
    return snapshot;
  });

  backfillFamilyHistory({ history: legacyHistory, snapshots: legacySnapshots });

  assert.equal(legacyHistory.familySchemaVersion, GAME_FAMILY_SCHEMA_VERSION);
  assert.equal(legacyHistory.familyHistorySource, 'snapshots');
  assert.equal(Object.keys(legacyHistory.families).length, 1);
  assert.deepEqual(legacyHistory.familyEvents, []);
  assert(legacyHistory.observations.every((observation) => observation.familyTotal === 1));
  assert(legacyHistory.observations.every((observation) => observation.productTotal === 1));
  assert(legacyHistory.snapshots.every((entry) => entry.familyTotal === 1));
  assert(legacyHistory.snapshots.every((entry) => entry.productTotal === 1));
  assert(legacyHistory.snapshots.every((entry) => entry.familyCounts?.total === 1));
  assert(legacyHistory.snapshots.every((entry) => entry.productCounts?.total === 1));
});

test('legacy history without snapshots seeds families without false events', () => {
  const current = catalogWithProducts(
    [['CONSOLE', 'Shared Game'], ['PC', 'Shared Game (Win)']],
    [
      { id: 'CONSOLE', platform: 'console' },
      { id: 'PC', platform: 'pc' }
    ],
    '2026-04-15T00:00:00.000Z'
  );
  const baseline = updateHistory({ current, generatedAt: current.generatedAt });
  const legacyHistory = structuredClone(baseline.history);
  delete legacyHistory.families;
  delete legacyHistory.familyEvents;
  delete legacyHistory.familyHash;
  delete legacyHistory.familySchemaVersion;
  legacyHistory.snapshots = [];
  for (const observation of legacyHistory.observations) {
    observation.total = observation.productTotal;
    observation.counts = observation.productCounts;
    observation.eventCounts = observation.productEventCounts;
    delete observation.familyTotal;
    delete observation.familyCounts;
    delete observation.familyEventCounts;
    delete observation.familyHash;
  }

  backfillFamilyHistory({ history: legacyHistory });

  assert.equal(legacyHistory.familyHistorySource, 'legacy-active-products');
  assert.equal(Object.keys(legacyHistory.families).length, 1);
  assert.deepEqual(legacyHistory.familyEvents, []);
  assert.equal(legacyHistory.observations[0].familyTotal, 1);
  assert.equal(legacyHistory.observations[0].productTotal, 2);
  assert.deepEqual(legacyHistory.observations[0].familyEventCounts, {});
  assert.equal(legacyHistory.observations[0].familyChanged, true);
  assert.equal(legacyHistory.observations[0].productChanged, true);
});

test('catalog action summary renders latest changes', () => {
  const status = {
    state: 'success',
    generatedAt: '2026-01-08T00:00:00.000Z',
    catalogGeneratedAt: '2026-01-08T00:00:00.000Z',
    changed: true,
    baseline: false,
    eventCounts: {
      added: 1,
      tier_added: 1
    },
    warnings: ['DisplayCatalog metadata lagged for one product.'],
    errors: [],
    actionRunUrl: 'https://github.com/example/catabox/actions/runs/123',
    leavingSoonTotal: 1,
    leavingSoonAdded: [{
      familyId: 'family-new',
      title: 'A&B <Game>',
      platforms: ['console']
    }],
    sourceHealth: {
      sigls: [
        {
          tier: 'ultimate',
          platform: 'console',
          status: 'ok',
          count: 2,
          sourceCount: 2
        }
      ],
      leavingSoon: [
        {
          platform: 'console',
          status: 'ok',
          count: 1,
          sourceCount: 1
        }
      ],
      displayCatalog: {
        status: 'ok',
        requested: 2,
        returned: 2
      }
    }
  };
  const history = {
    events: [
      {
        generatedAt: '2026-01-01T00:00:00.000Z',
        date: '2026-01-01',
        type: 'removed',
        productId: 'OLD',
        title: 'Old game'
      },
      {
        generatedAt: '2026-01-08T00:00:00.000Z',
        date: '2026-01-08',
        type: 'added',
        productId: 'NEW',
        title: 'A&B <Game>'
      },
      {
        generatedAt: '2026-01-08T00:00:00.000Z',
        date: '2026-01-08',
        type: 'tier_added',
        productId: 'NEW',
        title: 'A&B <Game>',
        tier: 'ultimate'
      }
    ],
    observations: [
      {
        generatedAt: '2026-01-08T00:00:00.000Z',
        total: 2
      }
    ]
  };

  const summary = buildCatalogSummary({ status, history, repository: 'example/catabox' });
  assert.match(summary, /# Catabox catalog update: 2 changes/);
  assert.match(summary, /\| Metric \| Value \|/);
  assert.match(summary, /A&B <Game>/);
  assert.match(summary, /Ultimate \/ Console/);
  assert.match(summary, /DisplayCatalog metadata/);
  assert.match(summary, /\| Leaving soon \| 1 \|/);
  assert.match(summary, /Leaving soon \/ Console/);
  assert.match(summary, /## Newly announced as Leaving Soon[\s\S]*A&B <Game>[\s\S]*Console/);
  assert.doesNotMatch(summary, /Old game/);
});

test('catalog action summary leads with families and retains product audit events', () => {
  const generatedAt = '2026-05-01T00:00:00.000Z';
  const status = {
    state: 'success',
    generatedAt,
    catalogGeneratedAt: generatedAt,
    familyChanged: true,
    productChanged: true,
    familyEventCounts: { added: 1 },
    productEventCounts: { added: 2 },
    total: 731,
    productTotal: 919,
    warnings: [],
    errors: []
  };
  const history = {
    familyEvents: [{
      generatedAt,
      date: '2026-05-01',
      type: 'added',
      familyId: 'family-example',
      variantIds: ['SKU-A', 'SKU-B'],
      title: 'Example Game'
    }],
    events: [{
      generatedAt,
      date: '2026-05-01',
      type: 'added',
      productId: 'SKU-A',
      title: 'Example Game PC'
    }],
    observations: [{
      generatedAt,
      familyTotal: 731,
      productTotal: 919
    }]
  };

  const summary = buildCatalogSummary({ status, history });
  assert.match(summary, /\| Game families \| 731 \|/);
  assert.match(summary, /\| Product listings \| 919 \|/);
  assert.match(summary, /## Game-family changes[\s\S]*family-example[\s\S]*SKU-A, SKU-B/);
  assert.match(summary, /## Product-listing audit[\s\S]*SKU-A/);
});
