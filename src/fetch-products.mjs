import { readFile } from 'node:fs/promises';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_MARKET,
  USER_AGENT,
  buildDisplayCatalogUrl,
  isMainModule,
  stableStringify,
  uniqueSorted,
  writeJsonFile
} from './constants.mjs';

export async function requestProductJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (!fetchImpl) {
    throw new Error('No fetch implementation is available. Use Node 20 or newer.');
  }
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export function chunkProductIds(productIds, chunkSize = 80) {
  const ids = uniqueSorted(productIds);
  const chunks = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function fetchProducts(productIds, {
  market = DEFAULT_MARKET,
  language = DEFAULT_LANGUAGE,
  chunkSize = 80,
  fetchImpl
} = {}) {
  const chunks = chunkProductIds(productIds, chunkSize);
  const products = {};
  const chunksStatus = [];
  for (const ids of chunks) {
    const url = buildDisplayCatalogUrl({ productIds: ids, market, language });
    const payload = await requestProductJson(url, { fetchImpl });
    const returnedProducts = Array.isArray(payload?.Products) ? payload.Products : [];
    for (const product of returnedProducts) {
      if (product?.ProductId) {
        products[String(product.ProductId).toUpperCase()] = product;
      }
    }
    chunksStatus.push({
      url,
      requested: ids.length,
      returned: returnedProducts.length,
      status: 'ok'
    });
  }
  const requestedIds = uniqueSorted(productIds);
  const missingProductIds = requestedIds.filter((id) => !products[id]);
  return {
    products,
    requestedProductIds: requestedIds,
    missingProductIds,
    source: {
      endpoint: 'DisplayCatalog',
      market,
      language,
      chunkSize,
      chunks: chunksStatus,
      requested: requestedIds.length,
      returned: Object.keys(products).length
    }
  };
}

export function productIdsFromSiglsPayload(payload) {
  const lists = Array.isArray(payload?.lists) ? payload.lists : Array.isArray(payload) ? payload : [];
  return uniqueSorted(lists.flatMap((list) => list.productIds ?? []));
}

function parseCliArgs(argv) {
  const args = {
    market: DEFAULT_MARKET,
    language: DEFAULT_LANGUAGE,
    out: null,
    sigls: null,
    ids: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--market') {
      args.market = argv[++index];
    } else if (arg === '--language') {
      args.language = argv[++index];
    } else if (arg === '--out') {
      args.out = argv[++index];
    } else if (arg === '--sigls') {
      args.sigls = argv[++index];
    } else if (arg === '--ids') {
      args.ids = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  let ids = [];
  if (args.ids) {
    ids = args.ids.split(',').map((id) => id.trim());
  } else if (args.sigls) {
    ids = productIdsFromSiglsPayload(JSON.parse(await readFile(args.sigls, 'utf8')));
  } else {
    throw new Error('Pass --ids <comma-separated-product-ids> or --sigls <file>');
  }
  const result = await fetchProducts(ids, {
    market: args.market,
    language: args.language
  });
  if (args.out) {
    await writeJsonFile(args.out, result);
  } else {
    process.stdout.write(stableStringify(result));
  }
}

if (isMainModule(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
