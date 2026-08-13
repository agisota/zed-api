/**
 * Isolated catalog staging smoke — no Next/Turbopack production build.
 *
 * Serves GET /v1/models through getUnifiedModelsResponse on 127.0.0.1 and
 * asserts the public ROX plane plus OpenRouter absence.
 *
 *   DISABLE_SQLITE_AUTO_BACKUP=true ROX_PUBLIC_CATALOG_ONLY=true \
 *     node --import tsx/esm \
 *       --import ./open-sse/utils/setupPolyfill.ts \
 *       --import ./tests/_setup/isolateDataDir.ts \
 *       scripts/staging/catalog-smoke.ts
 *
 * Pass --listen to keep the local server up after the assertions.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { getUnifiedModelsResponse } from "../../src/app/api/v1/models/catalog.ts";
import { createProviderConnection } from "../../src/lib/db/providers.ts";

const PUBLIC_IDS = ["rox/explore", "rox/standard", "rox/max", "rox/vision", "rox/fast"] as const;
const OPENROUTER_UPSTREAM_ID = "openai/gpt-4o-staging-smoke";
const KEEP_LISTENING = process.argv.includes("--listen");

function dataDir(): string {
  const dir = process.env.DATA_DIR?.trim();
  if (!dir) {
    throw new Error("DATA_DIR must be set (isolateDataDir.ts or an explicit temp dir)");
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

async function main(): Promise<void> {
  process.env.API_KEY_SECRET ||= "rox-catalog-staging-smoke-secret";
  process.env.DISABLE_SQLITE_AUTO_BACKUP ||= "true";
  process.env.ROX_PUBLIC_CATALOG_ONLY ||= "true";
  process.env.APP_LOG_TO_FILE ||= "false";

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
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: String(error) } }));
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
  const response = await fetch(catalogUrl);
  const body = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const models = Array.isArray(body.data) ? body.data : [];
  const ids = models.map((model) => String(model.id ?? ""));
  const openRouterHits = models.filter(mentionsOpenRouter);
  const missingPublic = PUBLIC_IDS.filter((id) => !ids.includes(id));

  const report = {
    sha: process.env.STAGING_GIT_SHA ?? "local",
    listen: `127.0.0.1:${address.port}`,
    catalogUrl,
    status: response.status,
    modelCount: models.length,
    publicIdsPresent: PUBLIC_IDS.filter((id) => ids.includes(id)),
    missingPublic,
    openRouterCount: openRouterHits.length,
    openRouterSample: openRouterHits.slice(0, 5).map((model) => model.id),
    dataDir: dataDir(),
    hostname: os.hostname(),
    pid: process.pid,
  };

  const reportPath = path.join(os.tmpdir(), "rox-catalog-staging-smoke.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${reportPath}\n`);

  if (response.status !== 200) {
    throw new Error(`GET /v1/models returned ${response.status}`);
  }
  if (missingPublic.length > 0) {
    throw new Error(`missing public ROX ids: ${missingPublic.join(", ")}`);
  }
  if (openRouterHits.length > 0) {
    throw new Error(`OpenRouter leaked ${openRouterHits.length} catalog entries`);
  }

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
