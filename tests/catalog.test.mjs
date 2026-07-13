import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildCatalogSummary } from '../src/catalog-summary.mjs';
import { MAX_GAME_SCREENSHOTS } from '../src/constants.mjs';
import { parseSiglsResponse } from '../src/fetch-sigls.mjs';
import { normalizeCatalog } from '../src/normalize-catalog.mjs';
import { updateHistory } from '../src/update-history.mjs';
import { validateCatalog } from '../src/validate-data.mjs';

const products = JSON.parse(await readFile(new URL('./fixtures/products.json', import.meta.url), 'utf8'));

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

function currentFromLists(lists, generatedAt, productMap = products) {
  return normalizeCatalog({
    sigls: lists,
    products: productMap,
    productSource: { endpoint: 'fixture' },
    generatedAt,
    market: 'FR',
    language: 'en-us'
  });
}

test('SIGLS parsing applies known product swaps', () => {
  const parsed = parseSiglsResponse([
    { siglId: 'fixture', title: 'All games' },
    { id: '9PNQKHFLD2WQ' }
  ]);
  assert.deepEqual(parsed.productIds, ['9PNJXVCVWD4K']);
  assert.deepEqual(parsed.swapsApplied, [{ from: '9PNQKHFLD2WQ', to: '9PNJXVCVWD4K' }]);
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

  assert.equal(changed.catalogHash, current.catalogHash);
  assert.notDeepEqual(changed.games[0].screenshots, current.games[0].screenshots);
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
  assert.doesNotMatch(summary, /Old game/);
});
