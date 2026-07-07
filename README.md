# Catabox

Catabox is a zero-COGS static Xbox Game Pass catalog tracker. It publishes a GitHub Pages site from `docs/` and stores generated catalog data in plain JSON under `data/` and `docs/data/`.

The tracker is catalog-only: it does not use personal gamertags, libraries, played history, installed games, analytics, a server, a proxy, a database, paid storage, or runtime secrets.

## What it tracks

- Xbox Game Pass **Ultimate**, **Premium**, and **Essential**
- **Console** (`ConsoleGen8;ConsoleGen9`) and **PC** (`pc`)
- Default market availability: `FR`
- Default product names and metadata language: `en-us`

The generated `data/current.json` includes tier/platform lists, enriched game metadata, catalog diffs, tier-combination segments, source health, and a deterministic catalog hash. `docs/data/*.json` mirrors those files for the static site.

## Data sources

Catabox uses the public Xbox catalog endpoints from a GitHub Actions Node job:

- SIGLS catalog membership:
  `https://catalog.gamepass.com/sigls/v3?id=<tier-sigl-guid>&language=en-us&market=FR&platformContext=<ConsoleGen8;ConsoleGen9|pc>&subscriptionContext=<tier-product-id>`
- DisplayCatalog product metadata:
  `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<comma-separated-product-ids>&market=FR&languages=en-us&MS-CV=DGU1mcuYo0WMMp+F.1`

Observed SIGLS behavior: each request returns one list header followed by product IDs that appear to represent the catalog membership for that subscription context and platform context in the requested market. Catabox treats those lists as source-of-truth observations, not as a contractual Microsoft API guarantee.

Known tier constants:

| Tier | SIGLS ID | Subscription context |
| --- | --- | --- |
| Ultimate | `97c6c862-d28a-4907-a3d5-c401f2296a53` | `cfq7ttc0khs0` |
| Premium | `09a72c0d-c466-426a-9580-b78955d8173a` | `cfq7ttc0p85b` |
| Essential | `34031711-5a70-4196-bab7-45757dc2294e` | `cfq7ttc0k5dj` |

The known product swap `9PNQKHFLD2WQ -> 9PNJXVCVWD4K` is applied before metadata enrichment.

## Why fetching happens in GitHub Actions

Browser-side live fetching from `catalog.gamepass.com` is not viable for a public static site because the endpoint does not provide CORS headers that allow direct browser reads. Catabox fetches data in Node during a GitHub Actions run, commits static JSON, and the browser only reads adjacent `docs/data/*.json` files.

## Refresh cadence

The default workflow is weekly plus manual runs:

- Weekly schedule: Monday at 05:17 UTC
- Manual: `workflow_dispatch`

Daily or wave-window checks can be useful around known Xbox catalog update windows, but they are intentionally not enabled by default to keep the tracker low-noise and low-cost.

## History semantics

The first successful run is a **baseline observation**. Games present in that first run are marked as first observed, but not as truly new.

Later successful runs generate tracker-observed events:

- `added`
- `removed`
- `readded`
- `tier_added`
- `tier_removed`
- `platform_added`
- `platform_removed`

Membership-only snapshots are written only for baseline or changed runs under `data/snapshots/` and mirrored to `docs/data/snapshots/`.

## Validation and safety

`npm run update` fails if a required SIGLS request fails. On failure, `data/current.json`, `data/history.json`, and the generated site remain last-good; `data/status.json` and `docs/data/status.json` record the failed run so the site can show a banner.

Validation also checks:

- diff and segment IDs exist in `games`
- tier counts match raw SIGLS lists
- history events reference known tracked IDs
- generated JSON is deterministic
- warnings for `Premium not Ultimate`, `Essential not Premium`, or `Essential not Ultimate`
- warning for suspicious union-count swings above 20%

## Local development

Requirements: Node 20 or newer.

```sh
npm install
npm run update
npm test
npm run check
```

Open `docs/index.html` directly or serve `docs/` with any static file server. The site uses relative `data/current.json`, `data/history.json`, and `data/status.json` paths.

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run fetch` | Fetch and print SIGLS lists |
| `npm run normalize` | Normalize saved fetch/product payloads |
| `npm run history` | Update history from an existing `data/current.json` |
| `npm run build` | Copy the static site and JSON into `docs/` |
| `npm run update` | Full fetch, normalize, validate, history, and build pipeline |
| `npm test` | Run Node built-in tests |
| `npm run check` | Validate generated JSON |

## GitHub Pages setup

1. In repository settings, enable GitHub Pages and set the source to **GitHub Actions**.
2. Ensure Actions is allowed to create Pages deployments for the repository.
3. Run **Deploy GitHub Pages** manually once, or push a change to `docs/` on `main`.
4. Run **Update catalog** manually, or wait for the weekly schedule, to refresh and redeploy the generated site.

The update workflow commits only generated `data/` and `docs/` changes when those files change. The Pages workflow publishes the generated `docs/` site after direct `docs/` changes and after successful catalog updates.

## Limitations

- The public catalog endpoints are observed behavior and may change without notice.
- DisplayCatalog metadata can lag or omit fields for some products; Catabox keeps IDs even when metadata is sparse.
- Market availability defaults to France (`FR`) and product metadata language defaults to `en-us`.
- The site has no user accounts and does not know whether a visitor owns, played, installed, or wishlisted a game.
