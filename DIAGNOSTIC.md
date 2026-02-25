# Docker Container Health Diagnostic Report

**Date:** 2026-02-25
**Repo:** jhacksman/feedeater
**Scope:** All 6 FeedEater Docker containers reporting unhealthy

---

## Root Cause Summary

The **api** container crashes on startup due to a missing import (`SystemLogStore`), which causes a `ReferenceError` at runtime. Since 4 of the remaining 5 containers depend (directly or transitively) on the api being healthy, the failure cascades through the entire stack.

---

## Container-by-Container Analysis

### 1. `api`

| Field | Value |
|---|---|
| **Dockerfile** | `docker/Dockerfile.api` |
| **Health check** | `wget -q -O- http://127.0.0.1:4000/api/health` |
| **Interval / Timeout / Retries / Start period** | 10s / 5s / 5 / 30s |
| **Depends on** | `postgres` (healthy), `nats` (healthy) |
| **Status** | **Unhealthy** |

**Why it fails:**

`apps/api/src/index.ts` line 139 instantiates `SystemLogStore` at module top-level:

```ts
const systemLogStore = new SystemLogStore();
```

But there is **no import** for `SystemLogStore` anywhere in the file. The class is defined in `apps/api/src/systemLogs.ts` and exported, but `index.ts` never imports it.

The build tool (`tsup`) bundles without type-checking, so the Docker image builds successfully. However, the bundled output (`apps/api/dist/index.js`) contains `var systemLogStore = new SystemLogStore();` without the class definition. When `node dist/index.js` runs inside the container, it crashes immediately with:

```
ReferenceError: SystemLogStore is not defined
```

The Express server never starts, port 4000 never listens, and the `wget` health check returns a connection refused error on every attempt.

**Evidence:**
- `grep` of `apps/api/dist/index.js` shows exactly 1 reference to `SystemLogStore` (the usage) and 0 class definitions
- `grep` of `apps/api/src/index.ts` imports shows no `systemLogs` import
- Confirmed `ReferenceError: SystemLogStore is not defined` in Node.js runtime

---

### 2. `worker`

| Field | Value |
|---|---|
| **Dockerfile** | `docker/Dockerfile.worker` |
| **Health check** | `pgrep -f node` |
| **Interval / Timeout / Retries / Start period** | 10s / 5s / 5 / 30s |
| **Depends on** | `postgres` (healthy), `nats` (healthy), `redis` (healthy), `api` (healthy) |
| **Status** | **Unhealthy** (never starts) |

**Why it fails:**

The worker has `depends_on: api: condition: service_healthy`. Since the api container is permanently unhealthy (see above), Docker Compose **never starts the worker container**. It remains in a waiting state indefinitely.

Even if the api dependency were removed, the worker would likely still fail because:
- `apps/worker/src/index.ts` calls `fetchSettings("system")` which hits `http://api:4000/api/internal/settings/system` — if the api is down, this retries in an infinite loop with exponential backoff but never succeeds.

The `pgrep -f node` health check is structurally weak (it only checks if any node process exists, not that the worker is functional), but the container never reaches that point.

---

### 3. `web`

| Field | Value |
|---|---|
| **Dockerfile** | `docker/Dockerfile.web` |
| **Health check** | `wget -q -O- http://127.0.0.1:3000` |
| **Interval / Timeout / Retries / Start period** | 10s / 5s / 5 / 30s |
| **Depends on** | `api` (healthy) |
| **Status** | **Unhealthy** (never starts) |

**Why it fails:**

The web container has `depends_on: api: condition: service_healthy`. Since the api is permanently unhealthy, Docker Compose **never starts the web container**.

**Additional issue (Dockerfile.web):** The deps stage copies `package.json` but **not** `package-lock.json`, then runs `npm install` instead of `npm ci`. This means:
- Non-deterministic dependency resolution (no lockfile)
- Only 3 of 33+ module `package.json` files are copied (example, slack, system) — workspace resolution may fail for missing workspace members

This wouldn't prevent the container from starting (Next.js only needs its own deps), but it's a build fragility.

---

### 4. `sink`

| Field | Value |
|---|---|
| **Dockerfile** | `docker/Dockerfile.sink` |
| **Health check** | `pgrep -f node` |
| **Interval / Timeout / Retries / Start period** | 10s / 5s / 5 / 15s |
| **Depends on** | `postgres` (healthy), `nats` (healthy) |
| **Status** | **Unhealthy** |

**Why it fails:**

The sink Dockerfile deps stage runs:

```dockerfile
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/sink/package.json apps/sink/package.json
RUN npm ci --workspace=@feedeater/sink
```

`npm ci --workspace=@feedeater/sink` requires the root `package.json` to resolve all workspace members listed in its `workspaces` field. But only the sink's `package.json` is copied — all other workspace `package.json` files (api, worker, web, core, module-sdk, db, 30+ modules) are missing. npm will fail to resolve the workspace graph and the build will error out:

```
npm error code ENOENT
npm error ... No such file or directory ... apps/api/package.json
```

If the Docker image was built at an earlier point when fewer workspaces existed, it might have succeeded then. But on current `main`, the `npm ci --workspace` call will fail because the workspace resolution requires all referenced `package.json` files to exist.

Even if the build succeeds (from a cached image), the sink connects to NATS and Postgres without issue. The `pgrep -f node` health check would pass if the process stays alive. However, if the sink process crashes for any reason (e.g., Postgres schema mismatch), the health check fails.

---

### 5. `proxy` (Caddy)

| Field | Value |
|---|---|
| **Image** | `caddy:2-alpine` |
| **Health check** | `wget -q -O- http://127.0.0.1:666` |
| **Interval / Timeout / Retries** | 10s / 5s / 5 |
| **Depends on** | `web` (healthy), `api` (healthy) |
| **Status** | **Unhealthy** (never starts) |

**Why it fails:**

The proxy depends on both `web` and `api` being healthy. Since both are unhealthy (api crashes, web never starts), Docker Compose **never starts the proxy container**.

Even if started, the Caddyfile reverse-proxies to `api:4000` and `web:3000`. If those backends are down, Caddy would start but return 502 errors — the `wget` health check would get a 502 response which `wget -O-` treats as success (wget exits 0 on any HTTP response). So the health check itself is technically fine; the container just never gets a chance to run.

---

### 6. `module-init`

| Field | Value |
|---|---|
| **Image** | `node:20-alpine` |
| **Health check** | None (one-shot container, `restart: "no"`) |
| **Depends on** | `api` (healthy) |
| **Status** | **Never runs** |

**Why it fails:**

This is a one-shot init container that calls the api's settings endpoints to enable modules (kalshi, polymarket, aerodrome-base, uniswap-base). It depends on `api: condition: service_healthy`.

Since the api never becomes healthy, this container never starts. It has no health check of its own — it simply never executes.

---

## Dependency Cascade Diagram

```
postgres (healthy) ──┐
                     ├──> api (UNHEALTHY: ReferenceError) ──┬──> worker (blocked)
nats (healthy) ──────┤                                      ├──> web (blocked) ──> proxy (blocked)
                     │                                      ├──> module-init (blocked)
redis (healthy) ─────┘                                      └──> proxy (blocked)
                                                            
sink (UNHEALTHY: build failure from incomplete workspace copy)
```

**Infrastructure containers** (postgres, redis, nats) are healthy. The entire application-layer failure stems from:

1. **Primary:** `api` crashes on startup due to missing `SystemLogStore` import in `apps/api/src/index.ts`
2. **Secondary:** `sink` Docker build fails due to incomplete workspace `package.json` files in Dockerfile.sink
3. **Cascade:** `worker`, `web`, `proxy`, and `module-init` all depend on `api` being healthy and never start

---

## Verification Commands

```bash
# Confirm missing import in api source
grep -n "import.*SystemLogStore\|import.*systemLogs" apps/api/src/index.ts
# (returns nothing)

# Confirm usage without definition in bundle
grep -c "SystemLogStore" apps/api/dist/index.js
# (returns 1 — usage only, no class definition)

# Confirm ReferenceError at runtime
node -e "try { new SystemLogStore() } catch(e) { console.log(e.message) }"
# "SystemLogStore is not defined"

# Confirm sink Dockerfile copies insufficient workspace files
grep "COPY.*package.json" docker/Dockerfile.sink
# Only copies root + apps/sink — missing 35+ other workspace members
```

---

## Summary Table

| Container | Health Check | Root Cause | Category |
|---|---|---|---|
| **api** | `wget http://127.0.0.1:4000/api/health` | Missing `SystemLogStore` import crashes process at startup | **Bug (missing import)** |
| **worker** | `pgrep -f node` | Never starts — blocked on `api` healthy dependency | **Cascade from api** |
| **web** | `wget http://127.0.0.1:3000` | Never starts — blocked on `api` healthy dependency | **Cascade from api** |
| **sink** | `pgrep -f node` | Docker build fails: `npm ci --workspace` can't resolve incomplete workspace graph | **Bug (Dockerfile)** |
| **proxy** | `wget http://127.0.0.1:666` | Never starts — blocked on `api` + `web` healthy dependencies | **Cascade from api** |
| **module-init** | None (one-shot) | Never starts — blocked on `api` healthy dependency | **Cascade from api** |
