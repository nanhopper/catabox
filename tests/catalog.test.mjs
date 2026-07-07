import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseSiglsResponse } from '../src/fetch-sigls.mjs';
import { normalizeCatalog } from '../src/normalize-catalog.mjs';
import { updateHistory } from '../src/update-history.mjs';

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

function currentFromLists(lists, generatedAt) {
  return normalizeCatalog({
    sigls: lists,
    products,
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
