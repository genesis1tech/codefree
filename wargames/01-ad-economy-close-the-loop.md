# Wargame: 01-ad-economy-close-the-loop

**Mission:** Close the CodeFree ad economy loop: (A) make view credits dwell-verified and cap-enforced, (B) wire the in-TUI ad panel and the click→credit path end to end, (C) build a local ad server that serves/ingests real ad traffic, (D) build a local OpenAI-compatible gateway and wire credit→token redemption through the withdrawal state machine.
**Target:** `/Users/g1tech/_dev/codefree` (branch `phase-one-ads`, Bun monorepo, Effect v4 beta)
**Executor:** GLM-5.2 (fallback Sonnet 5)
**Planned by:** Fable 5 on 2026-07-08

---

## Standing orders (read before Move 1)

- Work on a new branch: `git checkout -b minor/1-ad-economy-loop` from `phase-one-ads`. NEVER commit to `dev` or `main`. Commit after each phase with `feat(codefree): <description>`.
- All commands run from repo root `/Users/g1tech/_dev/codefree` unless a `--cwd` is given. Runtime is Bun (`bun`), pinned 1.3.14. Do NOT use npm/npx/node.
- `bun test` must be run per-package (`cd packages/core && bun test`), never from root (root `test` script intentionally exits 1).
- The codebase uses Effect v4 beta. In `packages/core` and `packages/opencode`, copy the idioms of the file you are editing (services are `Context.Service` tags wired with `Layer.effect`; recover with `Effect.catch` / `Effect.catchDefect` — NOT `catchAll`/`catchAllDefect`). In the two NEW packages (adserver, gateway) do NOT use Effect — plain Bun (`Bun.serve`, `bun:sqlite`) as specified in Moves 13–18.
- Every fire-and-forget path you touch must keep its `Effect.catchDefect` + `Effect.catch` wrapping — a credit-layer failure must never break a coding session. This is the fork's core invariant (see `droid-wiki/overview/architecture.md`).
- New tests use the existing naming convention: `test("VAL-<AREA>-<NNN>: <description>", ...)` — see `packages/core/test/payout.test.ts` for the pattern.
- Prefer `const`, early returns, small helpers below the happy path — see `AGENTS.md` in repo root.

## Recon findings (read-only) — facts this plan relies on

**Economics & storage**
- 1 credit = $0.01 (`CREDIT_USD_VALUE`), view = +4 (`AD_VIEW_CREDIT_REWARD`), click = +100 (`AFFILIATE_CLICK_CREDIT_REWARD`): `packages/core/src/wallet/config.ts:1-9`. `MAX_DAILY_CREDITS = 10000` and `MIN_ADS_PER_SESSION = 1` are defined there but **never enforced anywhere** (dead constants).
- Wallet = local SQLite via Drizzle: tables `wallet`, `wallet_transaction` (`packages/core/src/wallet/sql.ts:4-48`); `creditWallet`/`debitWallet` at `packages/core/src/wallet/index.ts:185-272`. Migrations live in `packages/core/src/database/migration/` (raw-SQL `up()`-only) and are registered in `packages/core/src/database/migration.gen.ts`.
- User id: `resolveUserID()` at `packages/opencode/src/session/codefree.ts:155-177` — remote account id if present, else persisted `cfu_<uuid>` file `codefree_local_user_id` under the global data dir.
- `applyUsage` (credits offset measured turn cost): core `packages/core/src/codefree.ts:17-37`, host wrapper `packages/opencode/src/session/codefree.ts:267-307`, call site `packages/opencode/src/session/processor.ts:753-771`.

**Ad layer**
- `maybeShowAd` at `packages/opencode/src/session/codefree.ts:180-265`: gate (`shouldShowAd`, `packages/core/src/ad/injector.ts:46-61`: enabled + `min_interval_ms` 30s + `max_ads_per_hour` 25) → `selectAd` (`injector.ts:69-92`: category filter, per-advertiser `frequency_cap` 3, score+round-robin) → publish synthetic markdown text part → persist impression → **credit +4 immediately** → emit events. Invoked forked at `processor.ts:439` (slot `thinking`, on reasoning-end) and `processor.ts:577` (slot `toolgap`, on tool-result).
- Impressions persist to `ad_impression`; clicks to `ad_click_event` (`packages/core/src/ad/sql.ts:7-43`). `AdStore.recordImpression`/`recordClick`/`getImpressionStats` at `packages/core/src/ad/service.ts:188-305`. `recordClick(impressionId, clickUrl)` returns `false` for unknown impression ids.
- `clickAd` (+100) at `codefree.ts:309-354` — **zero callers anywhere**. The impression id never reaches the client. `codefree.ad.click` event is defined and the TUI wallet store subscribes to it (`packages/tui/src/context/wallet.tsx:106-110`) but nothing ever emits it.
- `SLOT_MIN_DURATIONS` (`packages/core/src/ad/types.ts:86-90`), `AdSlot.min_duration_ms`, config `auto_dismiss_ms` (default 8000) — all defined, **never consumed**. Impression `duration_ms` currently stores time-since-previous-ad, not dwell (`codefree.ts:219-225`).
- `resetFrequencyCaps()` (`injector.ts:137-142`) exported, **never called** — advertiser counters grow forever in-process. The hourly `setInterval` at `codefree.ts:59-71` resets only `adCountsThisHour`.
- Remote ads: `AdSource.fetchAds(adServerUrl)` at `service.ts:134-181` — `GET {url}/ads`, `Accept: application/json`, 5s timeout, 5-min TTL cache, fallback to cached-then-`PLACEHOLDER_ADS` (6 hardcoded ads at `service.ts:11-78`). Response schema `AdServerResponse` at `service.ts:98-111`. No ad server exists in the repo.
- Config surface `codefree.*` in `opencode.json`: schema+defaults at `packages/core/src/config/codefree.ts:6-57` (`enabled` defaults **false**; `ad_server_url` optional). `readAdConfig` at `codefree.ts:140-149`.
- Events `codefree.ad.impression` / `codefree.ad.click` / `codefree.credit.updated` are ephemeral EventV2 defs inline at `codefree.ts:27-54`, bridged to the global bus by `packages/opencode/src/event-v2-bridge.ts`; the TUI matches them by raw type string (`wallet.tsx:94-122`).

**TUI**
- Live ads render only as transcript markdown (format at `injector.ts:97-106`). `packages/tui/src/ui/ad-banner.tsx` (`AdBanner`) is a complete bordered ad panel — 8s/12s auto-dismiss (`DEFAULT_DURATIONS`, lines 29-32), `[d]` dismiss (74-85), CTA mouse-up → `open(url)` with clipboard fallback (62-72) — **never imported anywhere** (dead).
- `/ads` dialog: command registered at `packages/tui/src/routes/session/index.tsx:560-570` → `DialogAds` (`packages/tui/src/routes/session/dialog-ads.tsx`) → `AdPreferences` (`packages/tui/src/ui/ad-preferences.tsx`) + `WithdrawPanel` (`packages/tui/src/ui/withdraw-panel.tsx`).
- `AdPreferences` category values (`devtools, cloud, education, productivity, open_source` at `ad-preferences.tsx:23`) DO NOT match the engine enum `AdCategory` (`devtool, saas, recruiting, education, affiliate` at `packages/core/src/ad/types.ts:16`) and persist only to client-side KV the engine never reads.
- `WithdrawPanel` "Withdraw all" calls `props.onRequestWithdraw?.(amount)` but `DialogAds` renders it **without that prop** (`dialog-ads.tsx:46`) — no-op. Its "Today" numbers are session counters relabeled (`dialog-ads.tsx:36-45`).
- Wallet store: `packages/tui/src/context/wallet.tsx` — subscribes to the three event strings, hydrated at boot via `CodeFree.hydrateWallet` (`processor.ts:117-122`).
- TUI server client: `useSDK()` from `packages/tui/src/context/sdk.tsx` wraps `createOpencodeClient` from `@opencode-ai/sdk/v2`.

**Payout (Phase 2, library-only)**
- `packages/core/src/wallet/payout.ts`: `requestWithdrawal` (156-235, escrow debit + `withdrawal` txn + row status `pending`; `manual` method auto-completes), `cancelWithdrawal` (253-298), `processWithdrawal` (300-319), `completeWithdrawal` (321-340), `failWithdrawal` (342-386, refunds), `getOrCreatePayoutAccount` (388-425, mock auto-active). `MIN_WITHDRAWAL_CREDITS = 1000` (payout.ts:93). `PayoutMethod = manual | stripe | paypal` — no real integrations. **Not wired to any route/UI**; only consumers are the barrel `packages/core/src/wallet.ts` and `packages/core/test/payout.test.ts`.

**Server & SDK plumbing**
- HTTP API pattern: one group file + one handler file per domain. Canonical example: `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` (HttpApiGroup + HttpApiEndpoint defs) and `.../handlers/config.ts` (`HttpApiBuilder.group(InstanceHttpApi, "config", ...)` yielding services). Groups are registered in `.../httpapi/api.ts`.
- SDK regen: `bun ./script/generate.ts` from repo root (builds sdk, runs `bun dev generate > ../sdk/openapi.json` inside packages/opencode, formats).
- Root scripts: `bun run lint` (oxlint), `bun run typecheck` (`bun turbo typecheck`).
- Provider base-URL seam exists (`packages/llm/src/route/endpoint.ts:23,48` and an `openai-compatible` provider at `packages/llm/src/providers/openai-compatible.ts`) — the gateway is consumed as an ordinary openai-compatible provider via config; NO changes to `packages/llm` are needed or allowed.

## Design decisions (already made — do not re-decide)

1. **Dwell-verified crediting (two-step impressions):** `maybeShowAd` stops crediting instantly. It records the impression un-credited and emits the impression event carrying the full creative + `impression_id`. The TUI shows the ad panel; after the slot's minimum duration it calls `POST /codefree/impression/{id}/complete`; the server re-checks elapsed time server-side (≥ `SLOT_MIN_DURATIONS[slot]`, minus 500ms network grace) and only then credits +4. No ack (headless session, early `[d]` dismiss, TUI crash) = no credit. The transcript markdown part is still published (durable record for non-TUI surfaces).
2. **Daily cap:** before ANY credit (view or click), sum today's positive `ad_view` + `affiliate_click` transactions for the user; if `earnedToday + reward > MAX_DAILY_CREDITS`, skip the credit (record the impression/click anyway, uncredited).
3. **Click loop:** AdBanner CTA → `POST /codefree/impression/{id}/click` → server `clickAd` (existing +100 path, now cap-checked) → TUI opens browser via existing `open()` logic. Unknown/duplicate impression id ⇒ no credit.
4. **Preferences:** engine categories are the source of truth. TUI checkbox VALUES become the engine enum (`devtool, saas, recruiting, education, affiliate`) with human labels. Preferences are stored server-side in a new `codefree_preference` table and overlaid by `readAdConfig`; the client KV keeps only the local mirror for instant UI state.
5. **Ad server (`packages/adserver`)** and **gateway (`packages/gateway`)** are NEW workspace packages using plain `Bun.serve` + `bun:sqlite` (no Effect). Local-run only: adserver on port **8790**, gateway on port **8791**. Cloud deployment is OUT OF SCOPE (abort condition).
6. **Redemption:** add payout method `"gateway"`. `POST /codefree/withdraw` → `requestWithdrawal(method: "gateway")` (escrow) → `POST {gateway_url}/accounts/{userId}/deposit` with `{usd}` → `completeWithdrawal` with the gateway receipt id; any HTTP failure → `failWithdrawal` (auto-refund). Gateway spends the balance by metering `POST /v1/chat/completions` passthrough usage against a static price table; balance ≤ 0 ⇒ HTTP 402. `stripe`/`paypal` stay stubs — do not touch them.

## RECON NEEDED (executor settles these in Move R1–R3 before Phase A)

- **R-A: Exact CodeFree service tag/accessor and whether its layer is reachable from HTTP handlers.** CHECK: `grep -rn "CodeFree" packages/opencode/src/server packages/opencode/src/session/codefree.ts | grep -i "layer\|Service\|export"` and read `codefree.ts:388-409` plus where `processor.ts` obtains the service (grep `codefree` in `processor.ts`). If the service layer is NOT provided to the handler context (grep the layer composition in `packages/opencode/src/server/routes/instance/httpapi/server.ts` and `handlers/` imports), take the Move 6 fork: give the new handler its own dependencies (Wallet + AdStore + EventV2 emit) instead of the CodeFree service.
- **R-B: How `EventV2` events are emitted outside the session processor (needed for route handlers to emit `codefree.credit.updated`).** CHECK: `grep -rn "EventV2.emit\|\.emit(" packages/opencode/src/session/codefree.ts | head` and copy that exact emission idiom into the handler.
- **R-C: How migrations are registered.** CHECK: read `packages/core/src/database/migration.gen.ts` and one existing migration (`packages/core/src/database/migration/20260628220041_payout_tables.ts`); replicate registration exactly (there may be a generator script — `grep -rn "migration" packages/core/package.json`; if a `generate`/`gen` script exists, run it instead of hand-editing the `.gen.ts`).
- **R-D: Whether `schema.json` (repo `packages/core/schema.json`) is generated and how.** CHECK: `grep -rn "schema.json" packages/core/package.json script/ | head`. If generated, run the generator after config-schema changes; if the check finds nothing, leave `schema.json` untouched.
- **R-E: How the session route mounts transient overlays (for AdBanner placement).** CHECK: `grep -n "Toast\|toast\|overlay\|absolute" packages/tui/src/routes/session/index.tsx | head -20` and read the closest transient-UI mount; mount AdBanner with the same mechanism adjacent to the prompt area.

## The route (move by move)

### Move R1: Branch + baseline green
Run: `git checkout -b minor/1-ad-economy-loop && cd packages/core && bun test; cd ../opencode && bun test; cd ../.. && bun run typecheck`
- **Expected observation:** new branch created; both test suites end with `0 fail`; turbo typecheck reports all tasks successful.
- **Most likely failure + cause:** pre-existing failures — the baseline is already red, not your doing.
- **Counter-move:** record the exact failing test names in `wargames/01-baseline-failures.txt`; these are exempt from your later verification (you must not make them worse, you need not fix them). If more than 5 tests fail at baseline, ABORT (see abort conditions).
- **Fork:** none.

### Move R2: Settle RECON R-A through R-E
Run each CHECK command above; write one line per finding into `wargames/01-recon-notes.md` (tag, answer, file:line).
- **Expected observation:** five answered lines; specifically R-A resolves to either "CodeFree service reachable in handlers via <tag>" or "not reachable — use Move 6 fork".
- **Most likely failure + cause:** grep returns nothing for R-A — the service is constructed only inside the session runtime scope.
- **Counter-move:** that IS an answer: take the Move 6 fork (handlers own their dependencies). Do not try to restructure the session runtime layers.
- **Fork:** outcomes only feed later forks; no branch here.

### Move R3: Read the four seam files fully
Read end to end: `packages/opencode/src/session/codefree.ts`, `packages/core/src/ad/service.ts`, `packages/core/src/wallet/payout.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` + `handlers/config.ts`.
- **Expected observation:** you can name, without re-opening the files, (a) the exact `AdServerResponse` field list, (b) the `requestWithdrawal` parameter list, (c) the group/handler registration steps.
- **Most likely failure + cause:** skipping this and hallucinating field names later — schema decode failures at runtime.
- **Counter-move:** re-read the specific lines cited in Recon findings above.

---

### PHASE A — trust & correctness

### Move 1: Migration — `credited` column + `codefree_preference` table
Create `packages/core/src/database/migration/<timestamp>_ad_trust.ts` (timestamp format matches existing files, e.g. `20260708120000_ad_trust.ts`), modeled on `20260628220041_payout_tables.ts`:
- `ALTER TABLE ad_impression ADD COLUMN credited INTEGER NOT NULL DEFAULT 0` and `ALTER TABLE ad_impression ADD COLUMN slot_min_ms INTEGER NOT NULL DEFAULT 8000`
- `CREATE TABLE codefree_preference (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, categories TEXT NOT NULL DEFAULT '[]', created_at ..., updated_at ...)` (copy timestamp column style from the payout migration).
Register per R-C. Mirror the columns in `packages/core/src/ad/sql.ts` (Drizzle table defs) and add the preference table there or in a new `packages/core/src/config/sql.ts` following whichever directory `ad/sql.ts` convention suggests (keep it in `ad/sql.ts` — one file, already imported by the store).
- **Expected observation:** `cd packages/core && bun test` still `0 fail`; a quick `grep -n "credited" packages/core/src/ad/sql.ts` shows the new column.
- **Most likely failure + cause:** migration not picked up (registration mismatch with `migration.gen.ts` convention) → tests that touch the DB fail with "no such column".
- **Counter-move:** re-run the R-C check; if a generator script exists, run it; else copy the exact export/name pattern of the newest existing migration entry.
- **Fork:** if `schema.gen.ts` also needs regeneration (R-C check shows a generator), run it; if hand-maintained, edit it the same way the payout migration's commit did (`git show 5374858b4 -- packages/core/src/database/schema.gen.ts` shows exactly what that commit added — imitate it).

### Move 2: Two-step impressions in core
In `packages/core/src/ad/service.ts` `AdStore`:
- `recordImpression` accepts/stores `credited: 0` and `slot_min_ms` (from `SLOT_MIN_DURATIONS[slot]`, `types.ts:86-90`).
- Add `getImpression(impressionId)` (copy the lookup inside `recordClick`, `service.ts:221-253`) and `markCredited(impressionId)` (UPDATE `credited=1`).
In `packages/core/src/wallet/index.ts` add `getEarnedToday(userId)`: SUM of positive `amount_credits` on `wallet_transaction` where `type IN ('ad_view','affiliate_click')` and `created_at >= start of current local day` (derive the day boundary the same way existing code derives timestamps in that file; if none, use `new Date(new Date().setHours(0,0,0,0)).getTime()` converted to the stored timestamp format — read how `created_at` is written in `creditWallet` first).
- **Expected observation:** `cd packages/core && bun test` `0 fail`; new functions exported from the barrels (`packages/core/src/ad/index.ts`, `packages/core/src/wallet/index.ts`).
- **Most likely failure + cause:** timestamp format mismatch (integer epoch vs ISO string) makes `getEarnedToday` return 0 always — silent, so write the test FIRST: `VAL-WALLET-020: getEarnedToday sums only today's ad_view/affiliate_click credits`.
- **Counter-move:** read the actual `created_at` value written by `creditWallet` (insert one row in the test and print it); match its type exactly.

### Move 3: Stop instant crediting in `maybeShowAd`; enrich the impression event
In `packages/opencode/src/session/codefree.ts`:
- Extend the `codefree.ad.impression` event schema (defined ~lines 27-54) with: `impression_id`, `slot_min_ms`, and the creative fields the panel needs (`headline`, `body`, `cta_text`, `cta_url`, `display_url`, `advertiser_id`, `category`). Keep the existing fields (`amount`, `ad_id`, `slot_type`, `session_id`) so the wallet store keeps working; `amount` now means "potential reward", keep it at 4.
- In `maybeShowAd` (180-265): keep gate → select → publish part → `trackImpression`/`recordImpression` (now with `credited: 0` + `slot_min_ms`), keep emitting the (enriched) impression event — but DELETE the `creditWallet(+4)` call and the `credit.updated` emission from this path. Cap counters (`lastAdTimes`, hourly count) still update as before.
- Add service method `completeImpression(impressionID)`: fetch impression (`getImpression`); if missing → return `{ credited: false, reason: "unknown" }`; if `credited === 1` → `{ credited: false, reason: "duplicate" }`; if `Date.now() - impression.created_at < slot_min_ms - 500` → `{ credited: false, reason: "too_fast" }`; else check `getEarnedToday(userID) + AD_VIEW_CREDIT_REWARD > MAX_DAILY_CREDITS` (import from `wallet/config.ts`) → `{ credited: false, reason: "daily_cap" }`; else `markCredited` → `creditWallet(+4, "ad_view", impressionID)` → emit `codefree.credit.updated` → `{ credited: true, balance }`. Wrap side effects in the same `Effect.catch`/`catchDefect` idiom used by `clickAd` (309-354).
- Apply the same daily-cap check inside `clickAd` before its `creditWallet(+100)`.
- **Expected observation:** `cd packages/opencode && bun test` — existing codefree tests fail loudly wherever they assert instant crediting. That is expected; fix those tests to assert the new two-step behavior in the same move. End state: `0 fail`.
- **Most likely failure + cause:** event schema change breaks the TUI's raw-string event decode (wallet store reads `properties` loosely — `wallet.tsx:99-122`) — additive fields are safe; renaming/removing fields is not.
- **Counter-move:** ONLY ADD fields to the event; never rename or remove existing ones.
- **Fork:** if tests reference `AD_VIEW_CREDIT_REWARD` being credited inside `maybeShowAd`, update those tests to call `completeImpression` explicitly — do not re-add crediting to `maybeShowAd`.

### Move 4: Hourly reset of advertiser frequency caps
In the existing hourly `setInterval` (`codefree.ts:59-71`), also call `resetFrequencyCaps()` (import from `@opencode-ai/core` ad barrel — check the import path other injector functions use in this file).
- **Expected observation:** `grep -n "resetFrequencyCaps" packages/opencode/src/session/codefree.ts` shows one import and one call inside the interval callback.
- **Most likely failure + cause:** import path wrong (barrel vs deep path) → typecheck error naming the module.
- **Counter-move:** import from wherever `selectAd`/`shouldShowAd` are already imported in this file.

### Move 5: Core tests for the new trust rules
Add to `packages/core/test/ad.test.ts` (follow file's existing harness/setup):
- `VAL-AD-020: recordImpression stores credited=0 and slot_min_ms`
- `VAL-AD-021: markCredited flips credited once` (second call is a no-op or returns false — match your implementation)
- `VAL-WALLET-021: daily cap blocks credit when earnedToday + reward exceeds MAX_DAILY_CREDITS`
- **Expected observation:** `cd packages/core && bun test` → all pass, `0 fail`.
- **Most likely failure + cause:** test DB not migrated with the new column — the test harness builds the schema from migrations; if it uses `schema.gen.ts` instead, your Move 1 fork answer covers it.
- **Counter-move:** open one existing passing ad test, copy its setup verbatim.

### Move 6: Server routes — `codefree` group
Create `packages/opencode/src/server/routes/instance/httpapi/groups/codefree.ts` + `handlers/codefree.ts`, cloning the structure of `groups/config.ts` / `handlers/config.ts` (same middleware, `described(...)` metadata, `OpenApi.annotations`). Endpoints:
- `POST /codefree/impression/{impressionID}/complete` → `{ credited: boolean, reason?: string, balance_credits?: number }`
- `POST /codefree/impression/{impressionID}/click` payload `{ click_url: string }` → `{ credited: boolean, balance_credits?: number }` (calls the `clickAd` path; unknown id ⇒ `credited: false`)
- `GET /codefree/wallet/summary` → `{ balance_credits, lifetime_earned, earned_today, ads_today, clicks_today }` (from wallet + `getImpressionStats`-style queries filtered to today)
- `PUT /codefree/preferences` payload `{ enabled: boolean, categories: string[] }` → upsert into `codefree_preference` keyed by resolved user id; response echoes stored row
- `POST /codefree/withdraw` payload `{ amount_credits: number }` → (implemented fully in Move 19; for now return the result of `requestWithdrawal(..., method: "gateway")` WITHOUT the gateway deposit — leave a `// Move 19 wires the gateway deposit` comment)
Register the group in `httpapi/api.ts` (import + `.add(...)` exactly like `ConfigApi`) and add the handler to wherever `configHandlers` is composed (grep `configHandlers` to find the composition site).
- **Expected observation:** `bun run typecheck` passes; `grep -n "codefree" packages/opencode/src/server/routes/instance/httpapi/api.ts` shows the registration.
- **Most likely failure + cause:** handler can't construct its dependencies (R-A said CodeFree service is session-scoped).
- **Counter-move (this is the R-A fork):** the handler builds its own small service set: `Wallet` + `AdStore` layers (both are core `Context.Service`s — see how `codefree.ts:388-409` composes them and copy that composition), resolves the user id by duplicating `resolveLocalUserID` logic through the same helper (export it from `session/codefree.ts` rather than copy-pasting), and emits events per R-B. Business logic (completeImpression/clickAd) should live in ONE place — if the fork fires, move `completeImpression` into `packages/core/src/codefree.ts` (pure core function taking Wallet+AdStore) and have both the session service and the handler call it.
- **Fork trigger:** if `bun run typecheck` fails with middleware/authorization type errors on the new group, diff your group file against `groups/config.ts` — the middleware chain must be identical.

### Move 7: SDK regeneration
Run: `bun ./script/generate.ts`
- **Expected observation:** exit 0; `git status` shows changes in `packages/sdk/js/src/gen/` (or `sdks/openapi.json`) including strings `codefree/impression` — confirm with `grep -rn "impression" packages/sdk/js/src/gen | head -3`.
- **Most likely failure + cause:** `bun dev generate` boots the host and fails on an unrelated runtime error — your new group has a schema that can't render to OpenAPI (e.g. a bare `Schema.Unknown`).
- **Counter-move:** read the error line; replace exotic schema types in your group with plain `Schema.Struct`/`Schema.String`/`Schema.Number`/`Schema.Boolean`/`Schema.Array(Schema.String)` only.
- **Fork:** if generation fails for a reason clearly unrelated to your group (error stack never mentions codefree), ABORT-CHECK: run `git stash && bun ./script/generate.ts`; if it still fails, the baseline is broken → record and continue WITHOUT SDK regen, calling the routes via raw `fetch` from the TUI (the sdk context exposes `props.fetch`/`baseUrl` — see `packages/tui/src/context/sdk.tsx`); `git stash pop` first.

### Move 8: Preferences plumbing
- `packages/core/src/config/codefree.ts`: extend `toAdConfig`/`readAdConfig` path so stored `codefree_preference` (when a row exists for the user) overrides `enabled` and `categories` from `opencode.json`. The DB read happens in `packages/opencode/src/session/codefree.ts` `readAdConfig` (140-149) — keep core pure.
- `packages/tui/src/ui/ad-preferences.tsx`: change `CATEGORIES` (line ~23) to value/label pairs over the ENGINE enum: `devtool` ("Dev tools"), `saas` ("SaaS & cloud"), `recruiting` ("Recruiting"), `education` ("Education"), `affiliate` ("Affiliate offers"). On toggle/category change, keep writing KV (instant UI) AND call `PUT /codefree/preferences` through the SDK client (get it via `useSDK()`; if Move 7 forked to raw fetch, `fetch(baseUrl + "/codefree/preferences", {method:"PUT", ...})`).
- `packages/tui/src/routes/session/dialog-ads.tsx`: replace the "Today" summary source with `GET /codefree/wallet/summary` fetched on dialog open; label the session counters "This session" if you keep them.
- **Expected observation:** `bun run typecheck` passes; grep shows no remaining `"devtools"`/`"open_source"` strings under `packages/tui/src`.
- **Most likely failure + cause:** old KV values (`codefree_ad_categories` containing legacy labels) decode into the new picker and render unchecked/unknown — a mapping problem, not a crash.
- **Counter-move:** on load, filter stored categories to the valid engine enum set; unknown values are dropped and re-persisted.

*Commit Phase A: `git add -A && git commit -m "feat(codefree): dwell-verified impressions, daily cap, preferences plumbing"`*

---

### PHASE B — in-TUI ad panel + click loop

### Move 9: Ad store signal in the TUI
In `packages/tui/src/context/wallet.tsx` (or a sibling `context/ad.tsx` if wallet.tsx would exceed ~400 lines): on `codefree.ad.impression`, stash the full payload (creative + `impression_id` + `slot_min_ms` + `session_id`) into a `currentAd` signal; clear it on dismissal/expiry. Keep the existing counter updates intact.
- **Expected observation:** typecheck passes; the store exposes `currentAd()`, `dismissAd()`.
- **Most likely failure + cause:** the enriched event fields are absent at runtime because an old server build is running — stale build, not a code bug.
- **Counter-move:** restart the dev host; confirm the event payload by temporarily logging `JSON.stringify(event.properties)` in the handler, then remove the log.

### Move 10: Mount AdBanner (the dead component comes alive)
Wire `packages/tui/src/ui/ad-banner.tsx` into the session route at the mount point found in R-E:
- Render when `currentAd()` is set. Map creative → existing `AdBanner` props (read its props type first, lines 1-40).
- Replace its `DEFAULT_DURATIONS` timing with the event's `slot_min_ms` for the credit timer; keep a dismissal timer at `slot_min_ms + 4000`.
- When the credit timer fires (panel still mounted, not dismissed): call `POST /codefree/impression/{id}/complete`; on `{credited:true}` the wallet updates via the `credit.updated` event (do NOT locally increment — the event is the source of truth). Show a brief "+4 credits" affordance using AdBanner's existing style primitives.
- `[d]` before the timer → `dismissAd()`, no ack, no credit (this is by design).
- **Expected observation:** `bun run typecheck` passes. (An interactive TUI check — panel appears after reasoning ends, credits tick +4 only after ~8s — is optional and NOT part of V1–V7; do not block on it.)
- **Most likely failure + cause:** OpenTUI overlay renders but steals focus/keyboard from the prompt — mount point wrong relative to the focus system.
- **Counter-move:** copy the exact mount pattern of the transient UI found in R-E (toast is non-focus-stealing); AdBanner's keyboard hook (74-85) already scopes to `[d]`.
- **Fork:** if `slot_min_ms` is missing from the event at runtime (older impression), fall back to `DEFAULT_DURATIONS[placement]` — code this fallback unconditionally.

### Move 11: Click → credit → browser
In AdBanner's CTA handler (62-72): first `POST /codefree/impression/{id}/click` with `{click_url: ad.cta_url}`, then proceed with the existing `open(url)` + clipboard fallback regardless of the response (credit and navigation are independent; never block the browser open on the network call — fire the POST and await it with a 3s timeout, swallow errors).
- **Expected observation:** clicking CTA opens the browser; wallet indicator jumps +100 (via `codefree.ad.click`/`credit.updated` events); `ad_click_event` row exists (`sqlite3` check in V4).
- **Most likely failure + cause:** double-click fires two POSTs — second returns `{credited:false, reason:"duplicate"}` because `recordClick` on an already-clicked impression must not credit twice.
- **Counter-move:** ensure the server treats an impression with `clicked=1` as duplicate (add that check in the click handler if `recordClick` doesn't already return false for it — read `service.ts:221-253` and test it in Move 12).

### Move 12: Host tests for the loop
In `packages/opencode/test/` (find the codefree test file — `grep -rln "maybeShowAd" packages/opencode/test`):
- `VAL-CF-030: completeImpression credits once, rejects duplicate`
- `VAL-CF-031: completeImpression rejects before slot_min_ms elapsed` (create impression with a forced old/new timestamp)
- `VAL-CF-032: click credits 100 once and is blocked by daily cap`
- `VAL-CF-033: maybeShowAd no longer credits directly` (balance unchanged after maybeShowAd alone)
- **Expected observation:** `cd packages/opencode && bun test` → `0 fail`.
- **Most likely failure + cause:** timing test flaky because it sleeps real time.
- **Counter-move:** don't sleep — write the impression row with a back-dated `created_at` directly through the store/DB in test setup.

*Commit Phase B: `feat(codefree): live ad panel with dwell-verified crediting and click loop`*

---

### PHASE C — the ad server

### Move 13: Scaffold `packages/adserver`
Create `packages/adserver/{package.json,src/index.ts,src/db.ts,src/seed.ts,test/adserver.test.ts}`. `package.json`: name `@codefree/adserver`, `"scripts": {"dev": "bun src/index.ts", "test": "bun test", "typecheck": "tsgo --noEmit"}` (copy `typecheck` script style from `packages/sdk/js/package.json`; if `tsgo` is not a repo dependency there, copy whatever `packages/core/package.json` uses). Plain Bun: `Bun.serve({ port: Number(process.env.CODEFREE_ADSERVER_PORT ?? 8790) })`, `bun:sqlite` `Database` at `process.env.CODEFREE_ADSERVER_DB ?? "adserver.db"` (add `*.db` to the package `.gitignore`). Tables: `ads(id TEXT PK, advertiser_id, category, headline, body, cta_text, cta_url, display_url, frequency_cap INTEGER, active INTEGER DEFAULT 1)`, `impressions(id TEXT PK, ad_id, user_id, slot_type, created_at INTEGER)`, `clicks(id TEXT PK, impression_id, ad_id, user_id, click_url, created_at INTEGER)`. `seed.ts` inserts 8 sample ads spread across all 5 engine categories.
**CRITICAL:** `GET /ads` must return JSON that decodes against `AdServerResponse` in `packages/core/src/ad/service.ts:98-111` — open that schema and mirror the field names/optionality EXACTLY (that schema, not this doc, is the contract).
- **Expected observation:** `bun run --cwd packages/adserver dev` prints listening on 8790; `curl -s localhost:8790/ads | head -c 200` shows `{"ads":[{...`.
- **Most likely failure + cause:** field mismatch with `AdServerResponse` (e.g. snake vs camel) → the host silently falls back to placeholder ads (fallback at `service.ts:163-171` swallows decode errors).
- **Counter-move:** write test `VAL-ADS-001` that imports nothing from core but asserts the response contains every field name you read in `service.ts:98-111`, spelled identically.

### Move 14: Targeting + ingestion endpoints
- `GET /ads?slot=<thinking|toolgap|idle>&categories=<csv>`: filter `active=1`; if `categories` present, filter to those; order: category ∈ slot-affinity first (mirror `SLOT_CATEGORY_AFFINITY` from `packages/core/src/ad/injector.ts:15-19` as a hardcoded map), then the rest; return max 20.
- `POST /impressions` body `{impression_id, ad_id, user_id, slot_type, created_at}` → insert (INSERT OR IGNORE on PK) → 204.
- `POST /clicks` body `{impression_id, ad_id, user_id, click_url}` → insert → 204.
- `GET /advertisers/:id/stats` → `{impressions: n, clicks: n, spend_usd: impressions*0.04 + clicks*1.00}` (advertiser-side accounting at the same rates users earn — placeholder economics, one constant block at top of file).
- Tests: `VAL-ADS-002` slot ordering, `VAL-ADS-003` ingestion idempotent on duplicate impression_id, `VAL-ADS-004` stats math.
- **Expected observation:** `cd packages/adserver && bun test` → `0 fail`.
- **Most likely failure + cause:** JSON body parsing of 204 routes (Bun `req.json()` throws on empty body) — always guard with try/catch returning 400.
- **Counter-move:** as stated; malformed body → 400 `{error}`.

### Move 15: Host reports traffic upstream
In `packages/opencode/src/session/codefree.ts`: when `codefree.ad_server_url` is set, fire-and-forget (same catch idiom) `POST {url}/impressions` after `recordImpression`, and `POST {url}/clicks` inside the click path after `recordClick` succeeds. Also extend `AdSource.fetchAds` (`packages/core/src/ad/service.ts:134-181`) to append `?slot=<slot>&categories=<csv>` when those are provided — thread `slot` through from `maybeShowAd`'s existing `slotType` argument. **Cache note:** the 5-min cache key currently is the URL — include the full URL-with-query as the key so thinking/toolgap don't cross-serve (read lines 94, 157-159 and key by the final URL string).
- **Expected observation:** with adserver running and `"codefree": {"enabled": true, "ad_server_url": "http://localhost:8790"}` in `opencode.json`, verification run V6 shows adserver rows appearing.
- **Most likely failure + cause:** Effect HttpClient POST idiom differs from the GET at 142-148 — wrong body encoding.
- **Counter-move:** grep `HttpClient` usage with a body elsewhere: `grep -rn "HttpBody\|post(" packages/core/src packages/opencode/src | grep -i http | head`; copy an existing POST idiom; if none exists anywhere, use `fetch` inside `Effect.tryPromise` with a 5s `AbortSignal.timeout(5000)`.

*Commit Phase C: `feat(adserver): local ad server with slot targeting and traffic ingestion`*

---

### PHASE D — gateway + redemption

### Move 16: Scaffold `packages/gateway`
Same skeleton as Move 13 (name `@codefree/gateway`, port env `CODEFREE_GATEWAY_PORT ?? 8791`, sqlite `gateway.db`). Tables: `accounts(user_id TEXT PK, api_key TEXT UNIQUE, balance_usd REAL NOT NULL DEFAULT 0, created_at INTEGER)`, `usage_events(id TEXT PK, user_id, model, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, created_at INTEGER)`, `deposits(id TEXT PK, user_id, usd REAL, reference TEXT, created_at INTEGER)`. Endpoints:
- `POST /accounts` body `{user_id}` → create-or-return `{user_id, api_key: "cfg_"+crypto.randomUUID(), balance_usd}` (idempotent: existing account returns existing key).
- `POST /accounts/:userId/deposit` body `{usd, reference}` → INSERT deposit + `UPDATE accounts SET balance_usd = balance_usd + ?` → `{deposit_id, balance_usd}`. Duplicate `reference` (UNIQUE index on `deposits.reference`) → 200 with existing deposit (idempotent), not a double-credit.
- `GET /accounts/:userId` → `{user_id, balance_usd}`.
- **Expected observation:** `curl -s -X POST localhost:8791/accounts -d '{"user_id":"cfu_test"}' -H 'content-type: application/json'` returns a `cfg_` key; repeating it returns the SAME key.
- **Most likely failure + cause:** forgetting the UNIQUE index on `deposits.reference` → double-crediting on withdraw retries (this breaks Move 19's safety).
- **Counter-move:** add the index in the CREATE TABLE DDL now; test `VAL-GW-002` posts the same reference twice and asserts balance increased once.

### Move 17: OpenAI-compatible passthrough with metering
`POST /v1/chat/completions`: require header `Authorization: Bearer cfg_...` → look up account; `balance_usd <= 0` → 402 `{error:{message:"CodeFree gateway balance exhausted"}}`. Forward the raw JSON body to `${process.env.CODEFREE_UPSTREAM_BASE_URL ?? "https://api.openai.com"}/v1/chat/completions` with `Authorization: Bearer ${process.env.CODEFREE_UPSTREAM_KEY}`.
- Non-stream (`"stream"` absent/false): await upstream JSON, read `usage.prompt_tokens`/`usage.completion_tokens`, meter, return body verbatim with upstream status.
- Stream (`"stream": true`): inject `"stream_options": {"include_usage": true}` into the forwarded body; pipe the upstream SSE bytes through untouched; tee the stream to scan for the final `usage` chunk; meter after stream end.
- Price table (one const at top): `{"gpt-4o": {in: 2.5, out: 10}, "gpt-4o-mini": {in: 0.15, out: 0.6}, "default": {in: 2.5, out: 10}}` USD per 1M tokens. `cost = pt*in/1e6 + ct*out/1e6`; `UPDATE accounts SET balance_usd = balance_usd - cost` (may go negative on the last call; next call 402s — acceptable).
- If `CODEFREE_UPSTREAM_KEY` is unset → 503 `{error:{message:"gateway upstream key not configured"}}` (this keeps the package testable without secrets).
- Tests (`VAL-GW-*`) must NOT hit the real OpenAI API: start a mock upstream with `Bun.serve` on an ephemeral port inside the test, point `CODEFREE_UPSTREAM_BASE_URL` at it. Cover: 402 on zero balance, metering math non-stream, metering from streamed usage chunk, 503 without upstream key.
- **Expected observation:** `cd packages/gateway && bun test` → `0 fail`.
- **Most likely failure + cause:** SSE tee implementation buffers or corrupts the stream (client sees nothing until the end) — piping through a transform that re-serializes instead of passing raw bytes.
- **Counter-move:** pass the upstream `response.body` ReadableStream straight through as the response body; do the usage-scan on a `tee()`d branch, never on the branch you return.

### Move 18: `gateway` payout method in core
In `packages/core/src/wallet/payout.ts`: add `"gateway"` to `PayoutMethod` (find its Schema definition — grep `PayoutMethod` in the file) and to any literal unions in `packages/core/src/wallet/sql.ts`. `requestWithdrawal` with method `gateway` behaves like `stripe`/`paypal` (stays `pending` — do NOT auto-complete like `manual`). No other state-machine changes. Update `packages/core/test/payout.test.ts` snapshot-ish assertions if they enumerate methods.
- **Expected observation:** `cd packages/core && bun test` → `0 fail`.
- **Most likely failure + cause:** a `Schema.Literals` union elsewhere (config schema/`schema.json`) also enumerates methods → typecheck or schema-decode failure naming the file.
- **Counter-move:** `grep -rn '"stripe"' packages/core/src | grep -v test` and add `"gateway"` at every site listed; re-run R-D's schema.json answer if config schema changed.

### Move 19: Wire `/codefree/withdraw` end to end
In `handlers/codefree.ts` withdraw handler (stub from Move 6): read `codefree.gateway_url` from config (add the optional key to `packages/core/src/config/codefree.ts` schema + defaults: `gateway_url` optional string, no default). Flow:
1. No `gateway_url` configured → return `{status:"unavailable", message:"configure codefree.gateway_url"}` (HTTP 200; the panel shows the message).
2. `requestWithdrawal({userId, amountCredits, method:"gateway"})` — handle its typed errors: `BelowMinimumWithdrawalError` → `{status:"below_minimum", min: 1000}`; `InsufficientBalanceError` → `{status:"insufficient"}`.
3. `processWithdrawal(id)` → `POST {gateway_url}/accounts/{userId}/deposit` with `{usd: creditsToUsd(amount), reference: withdrawalId}` (5s timeout).
4. 2xx → `completeWithdrawal(id, deposit_id)` → `{status:"completed", balance_usd}`. Non-2xx/timeout → `failWithdrawal(id, "gateway deposit failed: <detail>")` (auto-refunds) → `{status:"failed", refunded: true}`.
Also: ensure the gateway account exists first (`POST /accounts` is idempotent — call it before the deposit).
- **Expected observation:** Move 12-style host test `VAL-CF-040` with a mock gateway (Bun.serve in-test): balance 1500 → withdraw 1000 → wallet balance 500, withdrawal row `completed`, mock received one deposit with `reference` = withdrawal id. `VAL-CF-041`: mock returns 500 → wallet balance restored to 1500, row `failed`.
- **Most likely failure + cause:** retrying a timed-out deposit that actually landed (double credit) — prevented by the `reference` idempotency you built in Move 16; do NOT add client-side retries.
- **Counter-move:** none needed beyond no-retry; if the POST times out, treat as failure (refund). Worst case: gateway got the deposit AND wallet refunded — flag this known edge in a code comment and in the final report (acceptable for local/mock phase; a reconcile job is future work).

### Move 20: TUI redemption wiring
- `packages/tui/src/routes/session/dialog-ads.tsx`: pass `onRequestWithdraw` to `<WithdrawPanel>` — it calls `POST /codefree/withdraw` via SDK/fetch and feeds the response `status` back.
- `packages/tui/src/ui/withdraw-panel.tsx`: rename visible copy "Cash Out" → "Redeem for API tokens"; render per-status messages (`completed` → "Redeemed $X to your gateway balance", `failed` → "Redemption failed — credits refunded", `below_minimum`, `insufficient`, `unavailable`). Keep `MIN_WITHDRAWAL_CREDITS` display as is.
- **Expected observation:** `bun run typecheck` passes; grep shows `onRequestWithdraw` passed at the `dialog-ads.tsx` call site.
- **Most likely failure + cause:** the withdraw handler path needs the session/instance middleware query params the SDK adds automatically — raw-fetch fork users must append the same `directory` query the sdk context uses (see `packages/tui/src/context/sdk.tsx` init props).
- **Counter-move:** copy how another TUI fetch-to-route call site passes `directory` (grep `directory` in `packages/tui/src/context/sdk.tsx` and any raw fetch usage under `packages/tui/src`).

*Commit Phase D: `feat(codefree): local token gateway and credit redemption path`*

---

### PHASE E — sweep & verify

### Move 21: Dead-code sweep (only what this mission touched)
- `packages/core/src/ad/service.ts:80-86`: delete the legacy free function `fetchAds` returning placeholders IF `grep -rn "fetchAds" packages --include="*.ts" | grep -v "AdSource\|adserver\|test"` shows no other callers; otherwise leave it.
- `packages/core/src/wallet/config.ts`: `MIN_ADS_PER_SESSION` — delete if still unreferenced (`grep -rn MIN_ADS_PER_SESSION packages | grep -v config.ts` empty). `MAX_DAILY_CREDITS` is now used — keep.
- `AdBanner` is now live — remove nothing there.
- **Expected observation:** typecheck + both package test suites still green.
- **Most likely failure + cause:** a test imports the deleted symbol.
- **Counter-move:** the grep above includes tests only via `-v test` exclusion — re-run WITHOUT the exclusion before deleting; if a test references it, update the test.

### Move 22: Full verification battery + PR
Run every Verification run V1–V7 below, then: `git push -u origin minor/1-ad-economy-loop` and open a PR against `phase-one-ads` (NOT dev/main) with `gh pr create --base phase-one-ads --title "feat(codefree): close the ad economy loop" --body "<summary + test plan listing V1-V7 results>"`.
- **Expected observation:** all verifications pass (or only baseline-exempt failures from Move R1); PR URL printed.
- **Most likely failure + cause:** push rejected (no permission/remote) — environment, not code.
- **Counter-move:** stop after committing locally; report the branch name and V1–V7 results.

---

## Abort conditions (stop and flag — do not improvise)

1. Move R1 baseline shows **more than 5 failing tests** or typecheck failure in files you haven't touched → the branch is mid-refactor; report and stop.
2. Any fix requires editing upstream session-runtime files other than the named seams (`processor.ts` ad hooks, `codefree.ts`, the new route group/handler, migrations, ad/wallet/payout modules, the named TUI files) → stop; the credit layer must stay thin.
3. Anything demands real credentials, cloud deploys, or real payment-provider (Stripe/PayPal) integration → out of scope by design; stop and flag. (`CODEFREE_UPSTREAM_KEY` is only exercised manually by the user — tests must use the mock upstream.)
4. `bun ./script/generate.ts` fails even on a clean stash (Move 7 fork's abort-check) AND the raw-fetch fallback also fails to reach the new routes → stop; report both errors verbatim.
5. A migration cannot be registered without editing generated files in a way `git show 5374858b4` doesn't demonstrate → stop; schema pipeline knowledge is missing.
6. Cumulative diff (excluding the two new packages and generated SDK files) exceeds ~2500 changed lines → scope has drifted; stop and report what remains.

## Verification runs

1. **V1 core:** `cd packages/core && bun test` — pass: output ends `0 fail` (baseline-exempt failures from Move R1 excepted, count not increased).
2. **V2 host:** `cd packages/opencode && bun test` — pass: `0 fail` (same exemption rule).
3. **V3 new packages:** `cd packages/adserver && bun test && cd ../gateway && bun test` — pass: both `0 fail`.
4. **V4 adserver schema-on-disk:** start the adserver once (`bun run --cwd packages/adserver dev`, then Ctrl-C after the listening line), then run `sqlite3 packages/adserver/adserver.db "select count(*) from impressions;"` — pass: an integer prints without error (tables exist). Crediting-loop correctness itself is proven by VAL-CF-030/032 being green in V2.
5. **V5 static wiring:** `bun run typecheck && bun run lint` — pass: both exit 0.
6. **V6 adserver contract:** `curl -s "localhost:8790/ads?slot=thinking&categories=devtool" | bun -e "const j=await new Response(Bun.stdin.stream()).json(); if(!Array.isArray(j.ads)||j.ads.length===0) throw 'bad'; console.log('OK', j.ads.length)"` — pass: prints `OK <n>`.
7. **V7 gateway contract:** `curl -s -X POST localhost:8791/accounts -H 'content-type: application/json' -d '{"user_id":"cfu_verify"}' | grep -o 'cfg_' | head -1` — pass: prints `cfg_`. Then `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:8791/v1/chat/completions -H "Authorization: Bearer WRONG" -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[]}'` — pass: prints `401` (unknown key) — and with a valid key and zero balance — pass: `402`.

## Red-team record

- **Attack that failed against this plan (withstood):** *The unlucky path on Move 7 (SDK regen breaks).* The generation script boots the whole host; a plausible catastrophic stall for a literal executor. The plan already carries a three-layer counter: schema-simplification counter-move → stash-based baseline check → raw-fetch fallback with the exact context (`sdk.tsx` init props) needed to build requests by hand, plus abort condition 4 if both layers fail. The executor never has to invent a recovery.
- **Attack that landed + patch 1:** *The literal executor on Move 6.* The draft said "calls the clickAd path" while also saying handlers may not be able to reach the session-scoped CodeFree service — GLM-5.2 would stall choosing between duplicating business logic in the handler or restructuring layers (forbidden by abort 2). **Patch:** the R-A fork now names the exact resolution — hoist `completeImpression` into `packages/core/src/codefree.ts` as a pure core function over Wallet+AdStore and have both callers use it; export (not copy) the user-id helper.
- **Attack that landed + patch 2:** *The runaway on Move 19.* A deposit POST that times out after landing upstream would tempt a retry loop → double-credit, or silent wallet/gateway divergence. **Patch:** Move 16 now mandates a UNIQUE index on `deposits.reference` with an idempotent-200 semantics and a test (`VAL-GW-002`); Move 19 explicitly forbids client-side retries, treats timeout as failure (refund), and requires the known residual edge (deposit landed AND refunded) be flagged in a comment and the final report.
- **Attack that landed + patch 3:** *The silent assumption on event-shape compatibility (Move 3).* Enriching `codefree.ad.impression` could break the TUI's raw-string event decode. **Patch:** Move 3 now hard-rules "only ADD fields, never rename/remove", and Move 10 codes an unconditional fallback to `DEFAULT_DURATIONS` when `slot_min_ms` is absent.
