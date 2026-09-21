#!/usr/bin/env node
// Minimal zero-dependency static file server for previewing the generated
// `site/` output locally (and from the GitHub Copilot app's browser canvas).
//
// Usage: node src/serve-site.mjs [port]
// Default port: 4173. Override with the PORT env var or a CLI argument.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../site", import.meta.url)));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolvePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] || "/");
  const safePath = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  return join(ROOT, safePath);
}

async function handleRequest(req, res) {
  try {
    let filePath = resolvePath(req.url ?? "/");
    let fileStat = await stat(filePath).catch(() => null);

    if (fileStat?.isDirectory()) {
      filePath = join(filePath, "index.html");
      fileStat = await stat(filePath).catch(() => null);
    }

    if (!fileStat) {
      filePath = join(ROOT, "index.html");
      fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
    }

    const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Internal error: ${error.message}`);
  }
}

const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const server = createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(port, () => {
  console.log(`Catabox site preview running at http://localhost:${port}/`);
  console.log(`Serving files from: ${ROOT}`);
});
