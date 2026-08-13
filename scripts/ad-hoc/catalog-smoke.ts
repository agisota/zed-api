/**
 * Isolated catalog staging smoke — no Next/Turbopack production build.
 *
 * Binds 127.0.0.1 only. Do not point this at api.rox.one.
 *
 *   node --import tsx/esm \
 *     --import ./open-sse/utils/setupPolyfill.ts \
 *     scripts/ad-hoc/catalog-smoke.ts
 *
 * Pass --listen to keep the local server after both assertion passes.
 */
import "./catalog-smoke-data-dir.ts";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildErrorBody } from "../../open-sse/utils/error.ts";
import {
  getUnifiedModelsResponse,
  __resetCatalogBuilderRunsForTest,
} from "../../src/app/api/v1/models/catalog.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";
import { ROX_CATALOG_SMOKE_MARKER } from "./catalog-smoke-data-dir.ts";

const PUBLIC_IDS = ["rox/explore", "rox/standard", "rox/max", "rox/vision", "rox/fast"] as const;
const OPENROUTER_UPSTREAM_ID = "openai/gpt-4o-staging-smoke";
const KEEP_LISTENING = process.argv.includes("--listen");

function dataDir(): string {
  const dir = process.env.DATA_DIR?.trim();
  if (!dir) {
    throw new Error("DATA_DIR missing; load scripts/ad-hoc/catalog-smoke-data-dir.ts via --import");
  }
  const marker = path.join(dir, ROX_CATALOG_SMOKE_MARKER);
  if (!fs.existsSync(marker)) {
    throw new Error(
      `DATA_DIR ${dir} is not harness-owned; load scripts/ad-hoc/catalog-smoke-data-dir.ts via --import`
    );
  }
  return dir;
}

function seedOpenRouterCatalogCache(): void {
  const cacheDir = path.join(dataDir(), "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "openrouter-catalog.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: [
        {
          id: OPENROUTER_UPSTREAM_ID,
          name: "GPT-4o Staging Smoke",
          context_length: 128_000,
          pricing: { prompt: "0.0000025", completion: "0.00001" },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    }),
    "utf8"
  );
}

function mentionsOpenRouter(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return (
      lowered === "openrouter" ||
      lowered.startsWith("openrouter/") ||
      lowered.includes("/openrouter/") ||
      lowered.includes("openrouter_")
    );
  }
  if (Array.isArray(value)) return value.some(mentionsOpenRouter);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "id",
      "root",
      "parent",
      "owned_by",
      "provider",
      "providerId",
      "provider_id",
    ]) {
      if (mentionsOpenRouter(record[key])) return true;
    }
  }
  return false;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const request = new Request(url, { method: req.method ?? "GET", headers });
  const response = await getUnifiedModelsResponse(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function getCatalog(catalogUrl: string): Promise<{
  status: number;
  models: Array<Record<string, unknown>>;
  ids: string[];
}> {
  __resetCatalogBuilderRunsForTest();
  const response = await fetch(catalogUrl);
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const models = Array.isArray(body.data) ? body.data : [];
  return {
    status: response.status,
    models,
    ids: models.map((model) => String(model.id ?? "")),
  };
}

function assertExactPublicIds(ids: string[]): void {
  const sorted = [...ids].sort();
  const expected = [...PUBLIC_IDS].sort();
  if (sorted.length !== expected.length || sorted.some((id, index) => id !== expected[index])) {
    throw new Error(
      `public catalog must be exactly ${expected.join(", ")}; got ${ids.join(", ") || "(empty)"}`
    );
  }
}

async function main(): Promise<void> {
  process.env.API_KEY_SECRET ||= "rox-catalog-staging-smoke-secret";
  const ownedDir = dataDir();

  seedOpenRouterCatalogCache();
  await createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: "openrouter-staging-smoke",
    apiKey: "sk-or-staging-smoke",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      const body = buildErrorBody(
        500,
        error instanceof Error ? error.message : String(error),
        undefined,
        {
          type: "server_error",
          code: "INTERNAL_PROXY_ERROR",
        }
      );
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("catalog smoke server did not bind a TCP port");
  }

  const catalogUrl = `http://127.0.0.1:${address.port}/v1/models`;

  process.env.ROX_PUBLIC_CATALOG_ONLY = "true";
  const publicPass = await getCatalog(catalogUrl);
  if (publicPass.status !== 200) {
    throw new Error(`public-only GET /v1/models returned ${publicPass.status}`);
  }
  assertExactPublicIds(publicPass.ids);

  process.env.ROX_PUBLIC_CATALOG_ONLY = "false";
  const normalPass = await getCatalog(catalogUrl);
  if (normalPass.status !== 200) {
    throw new Error(`normal GET /v1/models returned ${normalPass.status}`);
  }
  const openRouterHits = normalPass.models.filter(mentionsOpenRouter);
  if (openRouterHits.length > 0) {
    throw new Error(`OpenRouter leaked ${openRouterHits.length} catalog entries in normal mode`);
  }

  const report = {
    sha: process.env.STAGING_GIT_SHA ?? "local",
    listen: `127.0.0.1:${address.port}`,
    catalogUrl,
    dataDir: ownedDir,
    publicOnly: {
      status: publicPass.status,
      modelCount: publicPass.ids.length,
      ids: publicPass.ids,
    },
    normal: {
      status: normalPass.status,
      modelCount: normalPass.ids.length,
      openRouterCount: openRouterHits.length,
      openRouterSample: openRouterHits.slice(0, 5).map((model) => model.id),
    },
    hostname: os.hostname(),
    pid: process.pid,
  };

  const reportPath = path.join(os.tmpdir(), "rox-catalog-staging-smoke.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${reportPath}\n`);
  process.stdout.write("catalog staging smoke: PASS\n");

  if (KEEP_LISTENING) {
    process.stdout.write(`listening at ${catalogUrl}\n`);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

await main();
