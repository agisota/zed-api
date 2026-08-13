# Isolated catalog staging

This harness exercises `GET /v1/models` through `getUnifiedModelsResponse`
without a Next/Turbopack production build (those OOM this class of VM).

It binds `127.0.0.1` only. Do not point it at `api.rox.one`.

```bash
DISABLE_SQLITE_AUTO_BACKUP=true \
ROX_PUBLIC_CATALOG_ONLY=true \
node --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  scripts/staging/catalog-smoke.ts
```

`--listen` keeps the local server after the assertions pass.
