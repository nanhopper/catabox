import { readFile } from 'node:fs/promises';
import {
  GENERATED_PATHS,
  RECOMMENDATION_ALGORITHM,
  RECOMMENDATION_LIST_LIMIT,
  RECOMMENDATION_SCHEMA_VERSION,
  isMainModule,
  writeJsonFile
} from './constants.mjs';

export const RECOMMENDATION_REASON_CODES = new Set([
  'sharedGenre',
  'sameDeveloper',
  'samePublisher',
  'sharedPlayerMode',
  'closeReleaseEra',
  'sharedKeywords',
  'sameTier',
  'samePlatform'
]);

const REASON_CODE_ORDER = [...RECOMMENDATION_REASON_CODES];
const DISCOVERY_POOL_LIMIT = RECOMMENDATION_LIST_LIMIT * 8;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'game',
  'games', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'play', 'the',
  'their', 'this', 'to', 'with', 'you', 'your'
]);
const BOOLEAN_MODE_FIELDS = {
  supportsSinglePlayer: 'singlePlayer',
  supportsMultiplayer: 'multiplayer',
  supportsOnlineMultiplayer: 'onlineMultiplayer',
  supportsLocalMultiplayer: 'localMultiplayer',
  supportsCoop: 'coop',
  supportsOnlineCoop: 'onlineCoop',
  supportsLocalCoop: 'localCoop'
};

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRecommendationName(value) {
  return typeof value === 'string'
    ? value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('en-US')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
    : '';
}

export function tokenizeRecommendationText(value) {
  return normalizeRecommendationName(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function normalizedSet(values) {
  return new Set((values ?? []).map(normalizeRecommendationName).filter(Boolean));
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  return intersectionSize(left, right) / new Set([...left, ...right]).size;
}

function canonicalMode(value) {
  const mode = normalizeRecommendationName(String(value).replace(/\([^)]*\)/g, ' '));
  if (!mode) return '';
  if (mode.includes('online') && /\bco op\b/.test(mode)) return 'onlineCoop';
  if (mode.includes('local') && /\bco op\b/.test(mode)) return 'localCoop';
  if (/\bco op\b/.test(mode)) return 'coop';
  if (mode.includes('online') && mode.includes('multiplayer')) return 'onlineMultiplayer';
  if (mode.includes('local') && mode.includes('multiplayer')) return 'localMultiplayer';
  if (mode.includes('multiplayer')) return 'multiplayer';
  if (mode.includes('single')) return 'singlePlayer';
  return `mode:${mode}`;
}

export function playerModeSignals(family) {
  const signals = new Set((family?.playerModes ?? []).map(canonicalMode).filter(Boolean));
  for (const [field, signal] of Object.entries(BOOLEAN_MODE_FIELDS)) {
    if (family?.[field] !== true) continue;
    if (field === 'supportsMultiplayer'
      && (signals.has('onlineMultiplayer') || signals.has('localMultiplayer'))) continue;
    if (field === 'supportsCoop'
      && (signals.has('onlineCoop') || signals.has('localCoop'))) continue;
    signals.add(signal);
  }
  return signals;
}

function releaseYear(family) {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(family?.releaseDate ?? '');
  return match ? Number(match[1]) : null;
}

export function recommendationFeatures(family) {
  return {
    genres: normalizedSet(family.genres),
    modes: playerModeSignals(family),
    tiers: normalizedSet(family.memberships),
    platforms: normalizedSet(family.platforms),
    developer: normalizeRecommendationName(family.developer),
    publisher: normalizeRecommendationName(family.publisher),
    year: releaseYear(family),
    keywords: new Set(tokenizeRecommendationText(`${family.title ?? ''} ${family.description ?? ''}`))
  };
}

export function reasonCodesForFeatures(left, right) {
  const valid = new Set();
  if (intersectionSize(left.genres, right.genres) > 0) valid.add('sharedGenre');
  if (left.developer && left.developer === right.developer) valid.add('sameDeveloper');
  if (left.publisher && left.publisher === right.publisher) valid.add('samePublisher');
  if (intersectionSize(left.modes, right.modes) > 0) valid.add('sharedPlayerMode');
  if (left.year != null && right.year != null && Math.abs(left.year - right.year) <= 5) {
    valid.add('closeReleaseEra');
  }
  if (intersectionSize(left.keywords, right.keywords) > 0) valid.add('sharedKeywords');
  if (intersectionSize(left.tiers, right.tiers) > 0) valid.add('sameTier');
  if (intersectionSize(left.platforms, right.platforms) > 0) valid.add('samePlatform');
  return REASON_CODE_ORDER.filter((code) => valid.has(code));
}

export function reasonCodesForPair(source, target) {
  return reasonCodesForFeatures(recommendationFeatures(source), recommendationFeatures(target));
}

function textTokens(family) {
  const title = tokenizeRecommendationText(family.title);
  const description = tokenizeRecommendationText(family.description);
  return [...title, ...title, ...title, ...description];
}

function buildTextVectors(families) {
  const documents = families.map(textTokens);
  const documentFrequency = new Map();
  for (const tokens of documents) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return documents.map((tokens) => {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const vector = new Map();
    let magnitudeSquared = 0;
    for (const [token, count] of counts) {
      const tf = 1 + Math.log(count);
      const idf = Math.log((families.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
      const weight = tf * idf;
      vector.set(token, weight);
      magnitudeSquared += weight * weight;
    }
    return { vector, magnitude: Math.sqrt(magnitudeSquared) };
  });
}

function cosine(left, right) {
  if (left.magnitude === 0 || right.magnitude === 0) return 0;
  const [small, large] = left.vector.size <= right.vector.size
    ? [left.vector, right.vector]
    : [right.vector, left.vector];
  let dot = 0;
  for (const [token, weight] of small) dot += weight * (large.get(token) ?? 0);
  return dot / (left.magnitude * right.magnitude);
}

function pairScore(left, right, leftText, rightText) {
  const yearProximity = left.year == null || right.year == null
    ? 0
    : Math.max(0, 1 - Math.abs(left.year - right.year) / 10);
  return (
    0.38 * cosine(leftText, rightText)
    + 0.16 * jaccard(left.genres, right.genres)
    + 0.14 * jaccard(left.modes, right.modes)
    + 0.08 * Number(Boolean(left.developer) && left.developer === right.developer)
    + 0.07 * Number(Boolean(left.publisher) && left.publisher === right.publisher)
    + 0.06 * yearProximity
    + 0.06 * jaccard(left.tiers, right.tiers)
    + 0.05 * jaccard(left.platforms, right.platforms)
  );
}

function normalizedScore(value) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

function compareCandidates(left, right) {
  return right.score - left.score || compareIds(left.id, right.id);
}

function rerankDiscover(sourceFeatures, candidates, pairScores, featuresById) {
  const remaining = candidates.slice(0, DISCOVERY_POOL_LIMIT);
  const selected = [];
  const sourceDeveloper = sourceFeatures.developer;
  const sourcePublisher = sourceFeatures.publisher;
  while (remaining.length > 0 && selected.length < RECOMMENDATION_LIST_LIMIT) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const candidateFeatures = featuresById.get(candidate.id);
      const candidateDeveloper = candidateFeatures.developer;
      const candidatePublisher = candidateFeatures.publisher;
      let redundancy = 0;
      let repeatsDeveloper = false;
      let repeatsPublisher = false;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, pairScores.get(`${candidate.id}\0${chosen.id}`) ?? 0);
        const chosenFeatures = featuresById.get(chosen.id);
        repeatsDeveloper ||= Boolean(candidateDeveloper)
          && candidateDeveloper === chosenFeatures.developer;
        repeatsPublisher ||= Boolean(candidatePublisher)
          && candidatePublisher === chosenFeatures.publisher;
      }
      const value = 0.72 * candidate.score
        - 0.22 * redundancy
        - 0.1 * Number(repeatsDeveloper)
        - 0.08 * Number(repeatsPublisher)
        - 0.04 * Number(Boolean(sourceDeveloper) && candidateDeveloper === sourceDeveloper)
        - 0.03 * Number(Boolean(sourcePublisher) && candidatePublisher === sourcePublisher);
      if (value > bestValue || (value === bestValue && compareIds(candidate.id, remaining[bestIndex].id) < 0)) {
        bestValue = value;
        bestIndex = index;
      }
    }
    const [candidate] = remaining.splice(bestIndex, 1);
    selected.push({ ...candidate, score: normalizedScore(bestValue / 0.72) });
  }
  return selected.sort(compareCandidates);
}

export function buildRecommendations({ current }) {
  if (!current || !Array.isArray(current.families)) {
    throw new TypeError('current.families must be an array');
  }
  const families = [...current.families].sort((left, right) => compareIds(left.id, right.id));
  const familiesById = new Map(families.map((family) => [family.id, family]));
  if (familiesById.size !== families.length) {
    throw new Error('current.families contains duplicate family IDs');
  }
  const features = families.map(recommendationFeatures);
  const featuresById = new Map(families.map((family, index) => [family.id, features[index]]));
  const textVectors = buildTextVectors(families);
  const pairScores = new Map();
  for (let leftIndex = 0; leftIndex < families.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < families.length; rightIndex += 1) {
      const score = pairScore(
        features[leftIndex],
        features[rightIndex],
        textVectors[leftIndex],
        textVectors[rightIndex]
      );
      pairScores.set(`${families[leftIndex].id}\0${families[rightIndex].id}`, score);
      pairScores.set(`${families[rightIndex].id}\0${families[leftIndex].id}`, score);
    }
  }

  const items = {};
  for (let sourceIndex = 0; sourceIndex < families.length; sourceIndex += 1) {
    const source = families[sourceIndex];
    const sourceModes = features[sourceIndex].modes;
    const candidates = families
      .filter((target) => target.id !== source.id)
      .map((target) => ({
        id: target.id,
        score: normalizedScore(pairScores.get(`${source.id}\0${target.id}`) ?? 0),
        reasons: reasonCodesForFeatures(features[sourceIndex], featuresById.get(target.id))
      }))
      .filter((candidate) => candidate.reasons.length > 0)
      .sort(compareCandidates);
    const sameMode = sourceModes.size === 0
      ? []
      : candidates.filter((candidate) =>
        intersectionSize(sourceModes, featuresById.get(candidate.id).modes) > 0
      ).slice(0, RECOMMENDATION_LIST_LIMIT);
    items[source.id] = {
      similar: candidates.slice(0, RECOMMENDATION_LIST_LIMIT),
      discover: rerankDiscover(features[sourceIndex], candidates, pairScores, featuresById),
      sameMode
    };
  }

  return {
    schemaVersion: RECOMMENDATION_SCHEMA_VERSION,
    algorithm: RECOMMENDATION_ALGORITHM,
    generatedAt: current.generatedAt,
    catalogHash: current.catalogHash,
    familyHash: current.familyHash,
    items
  };
}

async function runCli() {
  const current = JSON.parse(await readFile(GENERATED_PATHS.current, 'utf8'));
  const recommendations = buildRecommendations({ current });
  await writeJsonFile(GENERATED_PATHS.recommendations, recommendations);
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
