import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildRecommendations, RECOMMENDATION_REASON_CODES } from '../src/build-recommendations.mjs';
import {
  RECOMMENDATION_ALGORITHM,
  RECOMMENDATION_LIST_LIMIT,
  RECOMMENDATION_SCHEMA_VERSION
} from '../src/constants.mjs';

const template = await readFile(new URL('../src/report-template.html', import.meta.url), 'utf8');

function browserFunction(name) {
  const match = template.match(new RegExp(`    (?:async )?function ${name}\\([^]*?(?=\\n    (?:async )?function |\\n    init\\(\\);)`));
  assert.ok(match, `Browser function ${name} exists`);
  return match[0];
}

function browserFixture() {
  const current = {
    generatedAt: '2026-09-29T00:00:00.000Z',
    catalogHash: 'catalog',
    familyHash: 'families',
    families: ['source', 'first', 'second', 'third', 'fourth'].map((id) => ({
      id,
      title: `Racing ${id}`,
      genres: ['Racing'],
      memberships: ['ultimate'],
      platforms: ['console'],
      boxArt: `https://example.com/${id}.jpg`
    }))
  };
  const recommendations = buildRecommendations({ current });
  const slots = [{ dataset: { similarGame: 'source' }, innerHTML: '' }];
  const calls = [];
  const context = {
    app: { current, recommendations, view: 'cards' },
    location: { pathname: '/catabox/' },
    URLSearchParams,
    RECOMMENDATION_ALGORITHM,
    RECOMMENDATION_LIST_LIMIT,
    RECOMMENDATION_SCHEMA_VERSION,
    RECOMMENDATION_REASON_CODES,
    RECOMMENDATION_LIST_NAMES: ['similar', 'discover', 'sameMode'],
    cards: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-similar-game]');
        return slots;
      }
    },
    loadOptionalRecommendations: async () => ({ data: recommendations, error: '' }),
    renderRecommendations: () => calls.push('recommendations'),
    observeLazyImages: () => calls.push('images')
  };
  const names = [
    'currentFamilies', 'escapeHtml', 'catalogSearchUrl', 'thumbnailImage',
    'lazyImageHtml', 'similarGamesHtml', 'recommendationArtifactIssue', 'hydrateRecommendations'
  ];
  const browser = runInNewContext(`${names.map(browserFunction).join('\n')}\n({ ${names.join(', ')} })`, context);
  return { browser, context, recommendations, slots, calls };
}

function thumbnailIds(html) {
  return [...html.matchAll(/data-preview-game="([^"]+)"/g)].map((match) => match[1]);
}

test('card thumbnails use the model’s first three similar games regardless of taste or filters', () => {
  const { browser, context, recommendations } = browserFixture();
  const expected = recommendations.items.source.similar.slice(0, 3).map(({ id }) => id);
  const html = browser.similarGamesHtml({ id: 'source' });
  assert.deepEqual(thumbnailIds(html), expected);
  context.app.taste = { disliked: expected, played: expected, discovery: 'surprising' };
  context.app.filters = { search: 'unrelated', platforms: ['pc'] };
  context.app.rows = [];
  assert.equal(browser.similarGamesHtml({ id: 'source' }), html);
});

test('similar thumbnails hide unavailable data and handle short or invalid candidate lists', () => {
  const { browser, context } = browserFixture();
  assert.equal(browser.similarGamesHtml({ id: 'departed' }), '');
  context.app.recommendations.items.source.similar = [
    { id: 'source' }, { id: 'missing' }, { id: 'first' }, { id: 'first' }, { id: 'second' }
  ];
  assert.deepEqual(thumbnailIds(browser.similarGamesHtml({ id: 'source' })), ['first', 'second']);
  context.app.recommendations.items.source.similar = [];
  assert.equal(browser.similarGamesHtml({ id: 'source' }), '');
  delete context.app.recommendations.items.source;
  assert.equal(browser.similarGamesHtml({ id: 'source' }), '');
  context.app.recommendations = null;
  assert.equal(browser.similarGamesHtml({ id: 'source' }), '');
});

test('similar thumbnails have escaped accessible names, catalog links, lazy art and missing-art fallback', () => {
  const { browser, context } = browserFixture();
  const game = context.app.current.families[1];
  game.title = '<Race & "Win">';
  game.boxArt = 'https://example.com/art.jpg?x=1&y="2"';
  context.app.recommendations.items.source.similar = [{ id: game.id }];
  let html = browser.similarGamesHtml({ id: 'source' });
  assert.match(html, /aria-label="Games similar to Racing source"/);
  assert.match(html, /aria-label="&lt;Race &amp; &quot;Win&quot;&gt; — show in catalog"/);
  assert.ok(html.includes(`href="/catabox/?${new URLSearchParams({ search: game.title })}"`));
  assert.match(html, /data-src="https:\/\/example.com\/art.jpg\?x=1&amp;y=&quot;2&quot;"/);
  assert.match(html, /alt="" decoding="async" width="44" height="52"/);
  assert.doesNotMatch(html, /<Race|<img[^>]+ src=/);
  delete game.boxArt;
  html = browser.similarGamesHtml({ id: 'source' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<span aria-hidden="true">&lt;R<\/span>/);
  game.poster = 'poster.jpg';
  assert.match(browser.similarGamesHtml({ id: 'source' }), /data-src="poster.jpg"/);
  game.heroArt = 'hero.jpg';
  delete game.poster;
  assert.match(browser.similarGamesHtml({ id: 'source' }), /data-src="hero.jpg"/);
});

test('late recommendation hydration fills existing card slots without replacing the catalog', async () => {
  const { browser, context, recommendations, slots, calls } = browserFixture();
  context.app.recommendations = null;
  assert.equal(browser.similarGamesHtml({ id: 'source' }), '');
  await browser.hydrateRecommendations();
  assert.equal(context.app.recommendationsLoading, false);
  assert.deepEqual(thumbnailIds(slots[0].innerHTML), recommendations.items.source.similar.slice(0, 3).map(({ id }) => id));
  assert.deepEqual(calls, ['recommendations', 'images']);
});

test('failed, stale and malformed artifacts never populate similar-game strips', async () => {
  for (const scenario of ['failed', 'stale', 'malformed']) {
    const { browser, context, recommendations, slots } = browserFixture();
    if (scenario === 'failed') {
      context.loadOptionalRecommendations = async () => ({ data: null, error: 'offline' });
    } else if (scenario === 'stale') {
      recommendations.familyHash = 'old-catalog';
    } else {
      recommendations.items.source.similar[0].id = 'source';
    }
    await browser.hydrateRecommendations();
    assert.equal(context.app.recommendations, null);
    assert.equal(slots[0].innerHTML, '');
    assert.ok(context.app.recommendationError);
  }
});

test('hydration in table view does not eagerly observe hidden catalog thumbnails', async () => {
  const { browser, context, calls } = browserFixture();
  context.app.view = 'table';
  await browser.hydrateRecommendations();
  assert.deepEqual(calls, ['recommendations']);
});

test('both card renderers include strips and nested previews compare the nearest game target', () => {
  assert.match(browserFunction('renderCard'), /\$\{similarGamesHtml\(game\)\}/);
  assert.match(browserFunction('renderRecommendationCard'), /\$\{similarGamesHtml\(game\)\}/);
  assert.match(template, /\.similar-game-link:focus-visible/);
  assert.match(template, /\.similar-games-slot:empty\s*\{\s*display: none;/);
  assert.equal((browserFunction('bindEvents').match(/event\.relatedTarget\.closest\('\[data-preview-game\]'\) === target/g) ?? []).length, 2);
});
