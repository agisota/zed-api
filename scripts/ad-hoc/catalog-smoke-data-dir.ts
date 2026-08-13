/**
 * Preload for catalog-smoke.ts. Always replaces DATA_DIR with a harness-owned
 * temp directory so an inherited staging/production DATA_DIR cannot be mutated.
 *
 *   node --import tsx/esm \
 *     --import ./open-sse/utils/setupPolyfill.ts \
 *     --import ./scripts/ad-hoc/catalog-smoke-data-dir.ts \
 *     scripts/ad-hoc/catalog-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROX_CATALOG_SMOKE_MARKER = ".rox-catalog-smoke-owned";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rox-catalog-smoke-"));
process.env.DATA_DIR = dir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
fs.writeFileSync(path.join(dir, ROX_CATALOG_SMOKE_MARKER), `${dir}\n`, "utf8");

process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // OS reaps temp dirs.
  }
});
