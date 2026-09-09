import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RECOMMENDATION_REASON_CODES,
  buildRecommendations
} from '../src/build-recommendations.mjs';
import { validateRecommendations } from '../src/validate-data.mjs';

function family(id, overrides = {}) {
  return {
    id,
    title: id,
    description: '',
    genres: [],
    developer: '',
    publisher: '',
    releaseDate: null,
    playerModes: [],
    memberships: ['ultimate'],
    platforms: ['console'],
    supportsSinglePlayer: false,
    supportsMultiplayer: false,
    supportsOnlineMultiplayer: false,
    supportsLocalMultiplayer: false,
    supportsCoop: false,
    supportsOnlineCoop: false,
    supportsLocalCoop: false,
    ...overrides
  };
}

function fixtureCurrent() {
  return {
    generatedAt: '2026-09-09T12:00:00.000Z',
    catalogHash: 'catalog-fixture',
    familyHash: 'family-fixture',
    families: [
      family('alpha', {
        title: 'Galaxy Racing',
        description: 'Race futuristic vehicles through a neon galaxy championship.',
        genres: ['Racing'],
        developer: 'Velocity Works',
        publisher: 'Arcade House',
        releaseDate: '2024-01-01',
        playerModes: ['Online multiplayer (2-8)'],
        supportsMultiplayer: true,
        supportsOnlineMultiplayer: true
      }),
      family('alpha-clone', {
        title: 'Galaxy Racing Turbo',
        description: 'Race futuristic vehicles through a neon galaxy championship.',
        genres: ['racing'],
        developer: 'velocity works',
        publisher: 'arcade house',
        releaseDate: '2025-01-01',
        playerModes: ['Online multiplayer (2-12)'],
        supportsMultiplayer: true,
        supportsOnlineMultiplayer: true
      }),
      family('alpha-sequel', {
        title: 'Galaxy Racing Two',
        description: 'Race futuristic cars through another neon galaxy championship.',
        genres: ['Racing'],
        developer: 'Velocity Works',
        publisher: 'Arcade House',
        releaseDate: '2026-01-01',
        playerModes: ['Online multiplayer'],
        supportsMultiplayer: true,
        supportsOnlineMultiplayer: true
      }),
      family('circuit-rivals', {
        title: 'Circuit Rivals',
        description: 'Competitive racing championship with online rivals and precision driving.',
        genres: ['Racing'],
        developer: 'Different Studio',
        publisher: 'Different Publisher',
        releaseDate: '2023-01-01',
        playerModes: ['Online multiplayer (2-8)'],
        supportsMultiplayer: true,
        supportsOnlineMultiplayer: true,
        platforms: ['pc']
      }),
      family('local-karts', {
        title: 'Local Kart Party',
        description: 'Colorful kart racing for friends on one couch.',
        genres: ['Racing', 'Family'],
        developer: 'Party Lab',
        publisher: 'Friendly Games',
        releaseDate: '2022-01-01',
        playerModes: ['Local multiplayer (2-4)'],
        supportsMultiplayer: true,
        supportsLocalMultiplayer: true
      }),
      family('quiet-puzzle', {
        title: 'Quiet Blocks',
        description: 'A thoughtful single player puzzle about arranging mysterious blocks.',
        genres: ['Puzzle'],
        developer: 'Calm Studio',
        publisher: 'Indie Shelf',
        releaseDate: '2024-01-01',
        playerModes: ['Single player'],
        supportsSinglePlayer: true
      }),
      family('no-mode', {
        title: 'Museum Explorer',
        description: 'Explore a digital museum and learn about art history.',
        genres: ['Educational'],
        developer: 'Archive Team',
        publisher: 'Archive Team',
        releaseDate: '2020-01-01'
      })
    ]
  };
}

test('recommendation builds are deterministic and bind to the catalog', () => {
  const current = fixtureCurrent();
  const first = buildRecommendations({ current });
  const second = buildRecommendations({ current: structuredClone(current) });
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, current.generatedAt);
  assert.equal(first.catalogHash, current.catalogHash);
  assert.equal(first.familyHash, current.familyHash);
  assert.deepEqual(Object.keys(first.items).sort(), current.families.map(({ id }) => id).sort());
});

test('hybrid similarity finds the obvious neighbor with valid explanations', () => {
  const recommendations = buildRecommendations({ current: fixtureCurrent() });
  const best = recommendations.items.alpha.similar[0];
  assert.equal(best.id, 'alpha-clone');
  assert.ok(best.score > 0.5);
  assert.ok(best.reasons.includes('sharedGenre'));
  assert.ok(best.reasons.includes('sameDeveloper'));
  assert.ok(best.reasons.includes('sharedPlayerMode'));
  assert.ok(best.reasons.every((reason) => RECOMMENDATION_REASON_CODES.has(reason)));
});

test('lists contain no self references or duplicates and sameMode uses real signals', () => {
  const current = fixtureCurrent();
  current.families.push(...Array.from({ length: 14 }, (_, index) =>
    family(`extra-${String(index).padStart(2, '0')}`, {
      title: `Extra Adventure ${index}`,
      genres: ['Adventure'],
      developer: `Studio ${index}`,
      publisher: `Publisher ${index}`
    })
  ));
  const recommendations = buildRecommendations({ current });
  for (const [sourceId, lists] of Object.entries(recommendations.items)) {
    for (const candidates of Object.values(lists)) {
      assert.ok(candidates.length <= 12);
      assert.equal(candidates.some(({ id }) => id === sourceId), false);
      assert.equal(new Set(candidates.map(({ id }) => id)).size, candidates.length);
    }
  }
  assert.deepEqual(recommendations.items['no-mode'].sameMode, []);
  assert.ok(recommendations.items.alpha.sameMode.some(({ id }) => id === 'circuit-rivals'));
  assert.equal(recommendations.items.alpha.sameMode.some(({ id }) => id === 'local-karts'), false);
});

test('discovery reranking reduces near-identical publisher repetition', () => {
  const lists = buildRecommendations({ current: fixtureCurrent() }).items.alpha;
  assert.notDeepEqual(
    lists.discover.map(({ id }) => id),
    lists.similar.map(({ id }) => id)
  );
  assert.ok(
    lists.discover.findIndex(({ id }) => id === 'circuit-rivals')
      < lists.similar.findIndex(({ id }) => id === 'circuit-rivals')
  );
});

test('recommendation validation accepts the deterministic artifact', () => {
  const current = fixtureCurrent();
  const recommendations = buildRecommendations({ current });
  assert.deepEqual(validateRecommendations({ current, recommendations }), []);
});

test('recommendation validation rejects self references and invalid reasons', () => {
  const current = fixtureCurrent();
  const selfReference = buildRecommendations({ current });
  selfReference.items.alpha.similar[0].id = 'alpha';
  assert.match(validateRecommendations({ current, recommendations: selfReference }).join('\n'), /must not recommend its source family/);

  const invalidReason = buildRecommendations({ current });
  invalidReason.items.alpha.similar[0].reasons = ['madeUpReason'];
  assert.match(validateRecommendations({ current, recommendations: invalidReason }).join('\n'), /invalid reason code madeUpReason/);
});
