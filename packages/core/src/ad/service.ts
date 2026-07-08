import { eq, and, gte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Database } from "../database/database"
import { Identifier } from "../util/identifier"
import { AdClickEventTable, AdImpressionTable, CodefreePreferenceTable } from "./sql"
import { AdCreative, AdCreativeID, AdImpressionID, AdvertiserID, AdConfig, AdImpression, CREDITS_PER_CLICK, CREDITS_PER_VIEW, ImpressionStats } from "./types"

// -- Phase 0 placeholder ads --

const PLACEHOLDER_ADS: ReadonlyArray<AdCreative> = [
  new AdCreative({
    id: AdCreativeID.make("ad-vercel-001"),
    advertiser_id: AdvertiserID.make("vercel"),
    headline: "Ship faster with Vercel",
    body: "Zero-config deploys, edge functions, and instant previews. From localhost to production in seconds.",
    cta_text: "Start deploying free",
    cta_url: "https://vercel.com/?utm_source=codefree",
    display_url: "vercel.com",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: AdCreativeID.make("ad-supabase-001"),
    advertiser_id: AdvertiserID.make("supabase"),
    headline: "Supabase — Open Source Firebase Alternative",
    body: "Postgres database, auth, storage, and real-time subscriptions. Build in a weekend, scale to millions.",
    cta_text: "Get started free",
    cta_url: "https://supabase.com/?utm_source=codefree",
    display_url: "supabase.com",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: AdCreativeID.make("ad-railway-001"),
    advertiser_id: AdvertiserID.make("railway"),
    headline: "Railway — Deploy anything",
    body: "Infrastructure made simple. Spin up databases, deploy apps, and scale effortlessly. No YAML required.",
    cta_text: "Try Railway free",
    cta_url: "https://railway.app/?utm_source=codefree",
    display_url: "railway.app",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: AdCreativeID.make("ad-planetscale-001"),
    advertiser_id: AdvertiserID.make("planetscale"),
    headline: "PlanetScale — Serverless MySQL",
    body: "Branch your database like your code. Non-blocking schema changes, built-in connection pooling, and zero-downtime.",
    cta_text: "Start free tier",
    cta_url: "https://planetscale.com/?utm_source=codefree",
    display_url: "planetscale.com",
    category: "saas",
    format: "markdown",
  }),
  new AdCreative({
    id: AdCreativeID.make("ad-neon-001"),
    advertiser_id: AdvertiserID.make("neon"),
    headline: "Neon — Serverless Postgres",
    body: "Branching, auto-scaling, and bottomless storage. The developer-friendly Postgres built for modern apps.",
    cta_text: "Create free database",
    cta_url: "https://neon.tech/?utm_source=codefree",
    display_url: "neon.tech",
    category: "devtool",
    format: "markdown",
  }),
  new AdCreative({
    id: AdCreativeID.make("ad-convex-001"),
    advertiser_id: AdvertiserID.make("convex"),
    headline: "Convex — The Backend Platform",
    body: "Reactive queries, serverless functions, file storage, and real-time sync. Build full-stack apps without backend plumbing.",
    cta_text: "Start building",
    cta_url: "https://convex.dev/?utm_source=codefree",
    display_url: "convex.dev",
    category: "devtool",
    format: "markdown",
  }),
]

/**
 * Fetches available ads. Phase 0 returns hardcoded placeholders.
 * Kept for tests and direct callers that want the local pool without HTTP.
 */
export function fetchAds(_config: AdConfig): ReadonlyArray<AdCreative> {
  return PLACEHOLDER_ADS
}

// --- Remote ad source (Phase 1: ad server integration) ---
//
// When an ad server URL is configured, fetchAds hits the remote API and caches the result with a
// TTL. Any failure (network, parse, non-200) falls back to PLACEHOLDER_ADS so the session never
// blocks on ad delivery. When no URL is configured, placeholders are returned immediately.

const AD_FETCH_TTL_MS = 5 * 60 * 1000

// Wire schema for the ad server response body. Field names match AdCreative exactly so the
// decoded rows lift straight into AdCreative via the branded ID constructors.
const AdServerAd = Schema.Struct({
  id: Schema.String,
  advertiser_id: Schema.String,
  headline: Schema.String,
  body: Schema.String,
  cta_text: Schema.String,
  cta_url: Schema.String,
  display_url: Schema.String,
  category: Schema.String,
  format: Schema.optional(Schema.Literals(["text", "markdown"])),
  image_url: Schema.optional(Schema.String),
})

const AdServerResponse = Schema.Struct({ ads: Schema.Array(AdServerAd) })

interface AdSourceInterface {
  readonly fetchAds: (
    adServerUrl?: string,
    slot?: string,
    categories?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<AdCreative>>
}

class AdSourceService extends Context.Service<AdSourceService, AdSourceInterface>()("@opencode/AdSource") {}

function liftServerAd(row: typeof AdServerAd.Type): AdCreative {
  return new AdCreative({
    id: AdCreativeID.make(row.id),
    advertiser_id: AdvertiserID.make(row.advertiser_id),
    headline: row.headline,
    body: row.body,
    cta_text: row.cta_text,
    cta_url: row.cta_url,
    display_url: row.display_url,
    category: row.category as AdCreative["category"],
    format: (row.format ?? "markdown") as AdCreative["format"],
    image_url: row.image_url,
  })
}

export const adSourceLayer = Layer.effect(
  AdSourceService,
  Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    // Per-URL cache: { url, ads, fetchedAt }. Undefined = no valid cache entry.
    let cache: { url: string; ads: ReadonlyArray<AdCreative>; fetchedAt: number } | undefined

    const fetchRemote = (url: string) =>
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("Accept", "application/json"),
        http.execute,
        Effect.flatMap((res) => HttpClientResponse.schemaBodyJson(AdServerResponse)(res)),
        Effect.map((body) => body.ads.map(liftServerAd)),
        Effect.timeout("5 seconds"),
      )

    return AdSourceService.of({
      fetchAds: Effect.fn("AdSource.fetchAds")(function* (adServerUrl, slot, categories) {
        // No server configured — return the local placeholder pool (Phase 0 behavior).
        if (!adServerUrl) return PLACEHOLDER_ADS

        const params = new URLSearchParams()
        if (slot) params.set("slot", slot)
        if (categories && categories.length > 0) params.set("categories", categories.join(","))
        const query = params.toString()
        const url = query ? `${adServerUrl}/ads?${query}` : `${adServerUrl}/ads`

        // Serve from cache if still fresh.
        const now = Date.now()
        if (cache && cache.url === url && now - cache.fetchedAt < AD_FETCH_TTL_MS) {
          return cache.ads
        }

        const result = yield* fetchRemote(url).pipe(Effect.catch(() => Effect.succeed(null)))

        if (result) {
          cache = { url, ads: result, fetchedAt: now }
          return result
        }

        yield* Effect.logWarning("AdSource: remote fetch failed, falling back")
        return cache?.ads ?? PLACEHOLDER_ADS
      }),
    })
  }),
)

export const AdSource = {
  Service: AdSourceService,
  layer: adSourceLayer,
  defaultLayer: adSourceLayer.pipe(Layer.provide(FetchHttpClient.layer)),
}

// --- DB-backed impression store (Phase 1: durable persistence) ---
//
// Replaces the Phase 0 in-memory array. Impressions and click events now survive process
// restarts so /ads stats and ad-server attribution reflect the full history.

interface StoreInterface {
  readonly recordImpression: (impression: AdImpression) => Effect.Effect<void>
  readonly getImpression: (impressionId: string) => Effect.Effect<AdImpression | null>
  readonly markCredited: (impressionId: string) => Effect.Effect<boolean>
  readonly setImpressionShownAt: (impressionId: string, shownAt: number) => Effect.Effect<void>
  readonly recordClick: (impressionId: string, clickUrl: string) => Effect.Effect<boolean>
  readonly getImpressionStats: (sessionId: string) => Effect.Effect<ImpressionStats>
  readonly getTodayStats: (userId: string) => Effect.Effect<ImpressionStats>
  readonly getPreference: (userId: string) => Effect.Effect<{ enabled: boolean; categories: string[] } | null>
  readonly upsertPreference: (
    userId: string,
    enabled: boolean,
    categories: string[],
  ) => Effect.Effect<{ enabled: boolean; categories: string[] }>
  readonly clearImpressions: () => Effect.Effect<void>
}

class StoreService extends Context.Service<StoreService, StoreInterface>()("@opencode/AdStore") {}

export const layer = Layer.effect(
  StoreService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return StoreService.of({
      recordImpression: Effect.fn("AdStore.recordImpression")(function* (impression) {
        yield* db
          .insert(AdImpressionTable)
          .values({
            id: impression.id,
            ad_id: impression.ad_id,
            slot_type: impression.slot_type,
            session_id: impression.session_id,
            user_id: impression.user_id,
            shown_at: impression.shown_at,
            duration_ms: impression.duration_ms,
            clicked: impression.clicked ? 1 : 0,
            click_url: impression.click_url ?? null,
            credited: impression.credited ? 1 : 0,
            slot_min_ms: impression.slot_min_ms,
          })
          .run()
          .pipe(Effect.orDie)
      }),

      getImpression: Effect.fn("AdStore.getImpression")(function* (impressionId) {
        const row = yield* db
          .select()
          .from(AdImpressionTable)
          .where(eq(AdImpressionTable.id, impressionId))
          .get()
          .pipe(Effect.orDie)
        if (!row) return null
        return rowToImpression(row)
      }),

      markCredited: Effect.fn("AdStore.markCredited")(function* (impressionId) {
        const impression = yield* db
          .select()
          .from(AdImpressionTable)
          .where(eq(AdImpressionTable.id, impressionId))
          .get()
          .pipe(Effect.orDie)
        if (!impression || impression.credited === 1) return false
        yield* db
          .update(AdImpressionTable)
          .set({ credited: 1 })
          .where(eq(AdImpressionTable.id, impressionId))
          .run()
          .pipe(Effect.orDie)
        return true
      }),

      setImpressionShownAt: Effect.fn("AdStore.setImpressionShownAt")(function* (impressionId, shownAt) {
        yield* db
          .update(AdImpressionTable)
          .set({ shown_at: shownAt })
          .where(eq(AdImpressionTable.id, impressionId))
          .run()
          .pipe(Effect.orDie)
      }),

      recordClick: Effect.fn("AdStore.recordClick")(function* (impressionId, clickUrl) {
        const impression = yield* db
          .select()
          .from(AdImpressionTable)
          .where(eq(AdImpressionTable.id, impressionId))
          .get()
          .pipe(Effect.orDie)
        // Unknown or already-clicked impression: return false so the caller knows the click was not recorded.
        if (!impression || impression.clicked === 1) return false

        yield* db
          .update(AdImpressionTable)
          .set({ clicked: 1, click_url: clickUrl })
          .where(eq(AdImpressionTable.id, impressionId))
          .run()
          .pipe(Effect.orDie)

        yield* db
          .insert(AdClickEventTable)
          .values({
            id: "adc_" + Identifier.ascending(),
            impression_id: impressionId,
            ad_id: impression.ad_id,
            session_id: impression.session_id,
            user_id: impression.user_id,
            click_url: clickUrl,
            clicked_at: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)

        return true
      }),

      getImpressionStats: Effect.fn("AdStore.getImpressionStats")(function* (sessionId) {
        const impressions = yield* db
          .select()
          .from(AdImpressionTable)
          .where(eq(AdImpressionTable.session_id, sessionId))
          .all()
          .pipe(Effect.orDie)

        const totalClicks = impressions.filter((i) => i.clicked === 1).length
        const creditsEarned = impressions.length * CREDITS_PER_VIEW + totalClicks * CREDITS_PER_CLICK

        return new ImpressionStats({
          total_ads: impressions.length,
          total_clicks: totalClicks,
          credits_earned: creditsEarned,
        })
      }),

      getTodayStats: Effect.fn("AdStore.getTodayStats")(function* (userId) {
        const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
        const impressions = yield* db
          .select()
          .from(AdImpressionTable)
          .where(and(eq(AdImpressionTable.user_id, userId), gte(AdImpressionTable.shown_at, dayStart)))
          .all()
          .pipe(Effect.orDie)

        const totalClicks = impressions.filter((i) => i.clicked === 1).length
        const creditedViews = impressions.filter((i) => i.credited === 1).length
        const creditsEarned = creditedViews * CREDITS_PER_VIEW + totalClicks * CREDITS_PER_CLICK

        return new ImpressionStats({
          total_ads: impressions.length,
          total_clicks: totalClicks,
          credits_earned: creditsEarned,
        })
      }),

      clearImpressions: Effect.fn("AdStore.clearImpressions")(function* () {
        yield* db.delete(AdImpressionTable).run().pipe(Effect.orDie)
        yield* db.delete(AdClickEventTable).run().pipe(Effect.orDie)
      }),

      getPreference: Effect.fn("AdStore.getPreference")(function* (userId) {
        const row = yield* db
          .select()
          .from(CodefreePreferenceTable)
          .where(eq(CodefreePreferenceTable.user_id, userId))
          .get()
          .pipe(Effect.orDie)
        if (!row) return null
        return {
          enabled: row.enabled === 1,
          categories: JSON.parse(row.categories) as string[],
        }
      }),

      upsertPreference: Effect.fn("AdStore.upsertPreference")(function* (userId, enabled, categories) {
        const now = Date.now()
        const existing = yield* db
          .select()
          .from(CodefreePreferenceTable)
          .where(eq(CodefreePreferenceTable.user_id, userId))
          .get()
          .pipe(Effect.orDie)
        const payload = { enabled: enabled ? 1 : 0, categories: JSON.stringify(categories), time_updated: now }
        if (existing) {
          yield* db
            .update(CodefreePreferenceTable)
            .set(payload)
            .where(eq(CodefreePreferenceTable.user_id, userId))
            .run()
            .pipe(Effect.orDie)
        }
        if (!existing) {
          yield* db
            .insert(CodefreePreferenceTable)
            .values({ user_id: userId, ...payload, time_created: now })
            .run()
            .pipe(Effect.orDie)
        }
        return { enabled, categories }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

// Namespace grouping the store service tag and layers, mirroring the Wallet module shape.
export const Store = { Service: StoreService, layer, defaultLayer }

// Namespace accessors backed by StoreService — call sites do `yield* recordImpression(...)`.
export const recordImpression = Effect.fn("AdStore.recordImpression")(function* (impression: AdImpression) {
  const svc = yield* StoreService
  yield* svc.recordImpression(impression)
})

export const recordClick = Effect.fn("AdStore.recordClick")(function* (impressionId: string, clickUrl: string) {
  const svc = yield* StoreService
  return yield* svc.recordClick(impressionId, clickUrl)
})

export const getImpressionStats = Effect.fn("AdStore.getImpressionStats")(function* (sessionId: string) {
  const svc = yield* StoreService
  return yield* svc.getImpressionStats(sessionId)
})

export const clearImpressions = Effect.fn("AdStore.clearImpressions")(function* () {
  const svc = yield* StoreService
  yield* svc.clearImpressions()
})

function rowToImpression(row: typeof AdImpressionTable.$inferSelect): AdImpression {
  return new AdImpression({
    id: AdImpressionID.make(row.id),
    ad_id: AdCreativeID.make(row.ad_id),
    slot_type: row.slot_type as AdImpression["slot_type"],
    session_id: row.session_id,
    user_id: row.user_id,
    shown_at: row.shown_at,
    duration_ms: row.duration_ms,
    clicked: row.clicked === 1,
    click_url: row.click_url ?? undefined,
    credited: row.credited === 1,
    slot_min_ms: row.slot_min_ms,
  })
}

export * as Ad from "."
