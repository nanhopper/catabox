import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GENERATED_PATHS,
  PLATFORM_LABELS,
  TIER_LABELS,
  isMainModule,
  readJsonIfExists
} from './constants.mjs';

const EVENT_LABELS = {
  added: 'Added',
  removed: 'Removed',
  readded: 'Re-added',
  tier_added: 'Tier added',
  tier_removed: 'Tier removed',
  platform_added: 'Platform added',
  platform_removed: 'Platform removed'
};

function formatDateTime(value) {
  if (!value) {
    return 'Unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatNumber(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

function eventTotal(eventCounts = {}) {
  return Object.values(eventCounts).reduce((total, count) => total + Number(count ?? 0), 0);
}

function observationForStatus({ status, history }) {
  const generatedAt = status?.catalogGeneratedAt ?? status?.generatedAt;
  const observations = history?.observations ?? [];
  return observations.find((observation) => observation.generatedAt === generatedAt) ?? observations.at(-1) ?? null;
}

function eventLabel(type) {
  return EVENT_LABELS[type] ?? String(type ?? 'Unknown').replace(/_/g, ' ');
}

function tierLabel(tierId) {
  return TIER_LABELS[tierId] ?? tierId ?? '';
}

function platformLabel(platformId) {
  return PLATFORM_LABELS[platformId] ?? platformId ?? '';
}

function eventScope(event) {
  const parts = [];
  if (event.tier) {
    parts.push(tierLabel(event.tier));
  }
  if (event.platform) {
    parts.push(platformLabel(event.platform));
  }
  return parts.join(' / ') || 'Catalog';
}

function latestEventsForStatus({ status, history, maxEvents }) {
  const events = history?.events ?? [];
  const generatedAt = status?.catalogGeneratedAt ?? status?.generatedAt;
  const matchingEvents = generatedAt
    ? events.filter((event) => event.generatedAt === generatedAt)
    : events.slice(-maxEvents);
  return matchingEvents.slice(0, maxEvents);
}

function markdownCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

function markdownTable(headers, rows, emptyText) {
  if (rows.length === 0) {
    return `${emptyText}\n`;
  }
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`)
  ].join('\n') + '\n';
}

function summaryRows({ status, history, repository }) {
  const eventCount = eventTotal(status?.eventCounts);
  const observation = observationForStatus({ status, history });
  return [
    ['Repository', repository ?? process.env.GITHUB_REPOSITORY ?? 'Unknown'],
    ['Status', status?.state ?? 'unknown'],
    ['Generated at', formatDateTime(status?.catalogGeneratedAt ?? status?.generatedAt)],
    ['Total games', formatNumber(observation?.total ?? status?.total ?? status?.sourceHealth?.displayCatalog?.returned ?? 0)],
    ['Catalog changed', status?.changed ? 'Yes' : 'No'],
    ['Baseline run', status?.baseline ? 'Yes' : 'No'],
    ['Change events', pluralize(eventCount, 'event')],
    ['Warnings', pluralize(status?.warnings?.length ?? 0, 'warning')],
    ['Errors', pluralize(status?.errors?.length ?? 0, 'error')]
  ];
}

function eventCountRows(eventCounts = {}) {
  return Object.entries(eventCounts)
    .filter(([, count]) => Number(count) > 0)
    .sort(([leftType], [rightType]) => eventLabel(leftType).localeCompare(eventLabel(rightType)))
    .map(([type, count]) => [eventLabel(type), formatNumber(count)]);
}

function sourceRows(status) {
  const siglRows = (status?.sourceHealth?.sigls ?? []).map((source) => [
    `${tierLabel(source.tier)} / ${platformLabel(source.platform)}`,
    source.status ?? 'unknown',
    formatNumber(source.count),
    formatNumber(source.sourceCount)
  ]);
  const displayCatalog = status?.sourceHealth?.displayCatalog;
  if (!displayCatalog) {
    return siglRows;
  }
  return [
    ...siglRows,
    [
      'DisplayCatalog metadata',
      displayCatalog.status ?? 'unknown',
      formatNumber(displayCatalog.returned),
      formatNumber(displayCatalog.requested)
    ]
  ];
}

export function buildCatalogSummary({
  status,
  history = null,
  repository = process.env.GITHUB_REPOSITORY,
  maxEvents = 50
} = {}) {
  const eventCount = eventTotal(status?.eventCounts);
  const title = status?.state === 'success'
    ? `Catabox catalog update: ${status?.baseline ? 'baseline' : pluralize(eventCount, 'change')}`
    : `Catabox catalog update ${status?.state ?? 'unknown'}`;
  const latestEvents = latestEventsForStatus({ status, history, maxEvents }).map((event) => [
    eventLabel(event.type),
    event.title ?? event.productId,
    eventScope(event),
    event.productId ?? '',
    event.date ?? ''
  ]);
  const warnings = (status?.warnings ?? []).map((warning) => [warning]);
  const errors = (status?.errors ?? []).map((error) => [error]);
  const runLink = status?.actionRunUrl ? `\n[Open this GitHub Actions run](${status.actionRunUrl})\n` : '';
  const truncatedNotice = latestEvents.length >= maxEvents
    ? `\nShowing the first ${formatNumber(maxEvents)} changes from this run.\n`
    : '';

  return [
    `# ${title}`,
    runLink,
    '## Summary',
    markdownTable(['Metric', 'Value'], summaryRows({ status, history, repository }), 'No summary data was available.'),
    '## Change counts',
    markdownTable(['Change type', 'Count'], eventCountRows(status?.eventCounts), 'No catalog changes were detected in this run.'),
    '## Changes',
    markdownTable(['Type', 'Game', 'Tier / platform', 'Product ID', 'Date'], latestEvents, 'No individual change events were recorded for this run.'),
    truncatedNotice,
    '## Source health',
    markdownTable(['Source', 'Status', 'Returned', 'Requested/source count'], sourceRows(status), 'No source health data was available.'),
    '## Warnings',
    markdownTable(['Warning'], warnings, 'No warnings were recorded.'),
    '## Errors',
    markdownTable(['Error'], errors, 'No errors were recorded.')
  ].filter(Boolean).join('\n');
}

async function writeCatalogSummaryFile({
  statusPath = GENERATED_PATHS.status,
  historyPath = GENERATED_PATHS.history,
  outDir = '.tmp',
  maxEvents = 50
} = {}) {
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  const history = await readJsonIfExists(historyPath);
  const summary = buildCatalogSummary({ status, history, maxEvents });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'catalog-summary.md'), `${summary}\n`, 'utf8');
}

function parseCliArgs(argv) {
  const args = {
    statusPath: GENERATED_PATHS.status,
    historyPath: GENERATED_PATHS.history,
    outDir: '.tmp',
    maxEvents: 50
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') {
      args.statusPath = argv[++index];
    } else if (arg === '--history') {
      args.historyPath = argv[++index];
    } else if (arg === '--out-dir') {
      args.outDir = argv[++index];
    } else if (arg === '--max-events') {
      args.maxEvents = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  writeCatalogSummaryFile(args).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
