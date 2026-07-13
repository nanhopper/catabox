# Catabox

[Open the public Catabox site on GitHub Pages.](https://nanhopper.github.io/catabox/)

Catabox is a zero-COGS static Xbox Game Pass catalog tracker. It publishes a GitHub Pages site from `site/` and stores generated catalog data in plain JSON under `site/data/`.

Catabox is an unofficial fan-made tracker and is not affiliated with, endorsed by, or sponsored by Xbox or Microsoft.

The tracker is catalog-only: it does not use personal gamertags, libraries, played history, installed games, analytics, a server, a proxy, a database, paid storage, or runtime secrets.

## What it tracks

- Xbox Game Pass **Ultimate**, **Premium**, and **Essential**
- **Console** (`ConsoleGen8;ConsoleGen9`) and **PC** (`pc`)
- Default market availability: `FR`
- Default product names and metadata language: `en-us`

The generated `site/data/current.json` retains one source record per Xbox product ID and adds a display layer of semantic game families. Families are grouped only when titles match after conservative, versioned normalization of punctuation, presentation marks, Roman numerals, and explicit terminal platform qualifiers. Editions, remasters, remakes, bundles, subtitles, and bare `Console` titles remain distinct. The current product and family models each include counts, diffs, tier-combination segments, and deterministic membership hashes.

The site renders and counts game families first. A family with several PC, console, or generation-specific products exposes every Xbox product page in an accessible platform-aware disclosure; raw product IDs and metadata remain available for auditing. Visual metadata includes up to eight deduplicated DisplayCatalog screenshot thumbnails per family, loaded only while its preview popup is open.

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

Browser-side live fetching from `catalog.gamepass.com` is not viable for a public static site because the endpoint does not provide CORS headers that allow direct browser reads. Catabox fetches data in Node during a GitHub Actions run, commits static JSON, and the browser only reads adjacent `data/*.json` files from the published site.

## Refresh cadence

The default workflow is weekly plus manual runs:

- Weekly schedule: Monday at 05:17 UTC
- Manual: `workflow_dispatch`

Daily or wave-window checks can be useful around known Xbox catalog update windows, but they are intentionally not enabled by default to keep the tracker low-noise and low-cost.

### GitHub Actions summaries

Each update workflow run writes a GitHub Actions job summary led by game-family totals and events, followed by raw product-listing audit detail, source health, warnings, and errors. This uses GitHub's built-in workflow UI and does not require email credentials or repository secrets. Configure your personal GitHub notification settings to receive normal Actions status notifications for watched repositories.

## History semantics

The first successful run is a **baseline observation**. Game families and products present in that first run are marked as first observed, but not as truly new.

Later successful runs generate the following tracker-observed events at both family and product level:

- `added`
- `removed`
- `readded`
- `tier_added`
- `tier_removed`
- `platform_added`
- `platform_removed`

User-facing history uses aggregate family membership. Replacing one product ID with another inside the same family does not emit a game removal/addition, while raw product history still records the SKU churn. Membership-only snapshots are written only for baseline or changed runs under `site/data/snapshots/`.

## Validation and safety

`npm run update` fails if a required SIGLS request fails. On failure, `site/data/current.json`, `site/data/history.json`, and the generated site remain last-good; `site/data/status.json` records the failed run so the site can show a banner.

Validation also checks:

- product diff and segment IDs exist in `games`
- every product belongs to exactly one deterministic family
- family references, aggregates, counts, diffs, segments, and hashes reproduce exactly
- tier counts match raw SIGLS lists
- family and product history events reference known tracked IDs
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

Open `site/index.html` directly or serve `site/` with any static file server. The site uses relative `data/current.json`, `data/history.json`, and `data/status.json` paths.

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm run fetch` | Fetch and print SIGLS lists |
| `npm run normalize` | Normalize saved fetch/product payloads |
| `npm run history` | Update history from an existing `site/data/current.json` |
| `npm run migrate:families` | Rebuild family data and backfill family history from checked-in snapshots |
| `npm run summary:catalog` | Render the latest catalog update job summary |
| `npm run build` | Render the static site shell into `site/` |
| `npm run update` | Full fetch, normalize, validate, history, and build pipeline |
| `npm test` | Run Node built-in tests |
| `npm run check` | Validate generated JSON |

## GitHub Pages setup

1. In repository settings, enable GitHub Pages and set the source to **GitHub Actions**.
2. Ensure Actions is allowed to create Pages deployments for the repository.
3. Run **Deploy GitHub Pages** manually once, or push a change to `site/` on `main`.
4. Run **Update catalog** manually, or wait for the weekly schedule, to refresh and redeploy the generated site.

The update workflow commits only generated `site/` changes when those files change. The Pages workflow publishes the generated `site/` after direct `site/` changes and after successful catalog updates.

## Limitations

- The public catalog endpoints are observed behavior and may change without notice.
- DisplayCatalog metadata can lag or omit fields for some products; Catabox keeps IDs even when metadata is sparse.
- Conservative exact family matching intentionally leaves spelling and word-boundary aliases unmerged rather than risk false positives.
- Family IDs are title-derived, so a substantive upstream rename can produce family churn; product-level history remains authoritative.
- Market availability defaults to France (`FR`) and product metadata language defaults to `en-us`.
- The site has no user accounts and does not know whether a visitor owns, played, installed, or wishlisted a game.
