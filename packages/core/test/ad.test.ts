import { beforeEach, describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import {
  AdCategory,
  AdConfig,
  AdCreative,
  AdCreativeID,
  AdImpression,
  AdImpressionID,
  AdvertiserID,
  CREDITS_PER_CLICK,
  CREDITS_PER_VIEW,
} from "@opencode-ai/core/ad/types"
import { formatAdAsMarkdown, resetFrequencyCaps, scoreAd, selectAd, shouldShowAd, SLOT_CATEGORY_AFFINITY, trackImpression } from "@opencode-ai/core/ad/injector"
import { AdSource, clearImpressions, fetchAds, getImpressionStats, recordClick, recordImpression, Store } from "@opencode-ai/core/ad/service"
import { Database } from "@opencode-ai/core/database/database"
import { testEffect } from "./lib/effect"

// -- Test helpers --

function makeAd(id: string, advertiser: string, category: AdCategory): AdCreative {
  return new AdCreative({
    id: AdCreativeID.make(id),
    advertiser_id: AdvertiserID.make(advertiser),
    headline: `Headline for ${id}`,
    body: `Body text for ${id}`,
    cta_text: `Learn more about ${id}`,
    cta_url: `https://example.com/${id}`,
    display_url: `example.com/${id}`,
    category,
    format: "markdown",
  })
}

function makeConfig(overrides: {
  enabled?: boolean
  min_interval_ms?: number
  max_ads_per_hour?: number
  categories?: ReadonlyArray<AdCategory>
  frequency_cap?: number
} = {}): AdConfig {
  return new AdConfig({
    enabled: overrides.enabled ?? true,
    min_interval_ms: overrides.min_interval_ms ?? 30_000,
    max_ads_per_hour: overrides.max_ads_per_hour ?? 25,
    categories: overrides.categories ?? [],
    frequency_cap: overrides.frequency_cap ?? 3,
  })
}

// In-memory database provisioned with the ad tables via the fresh-DB schema snapshot.
const database = Database.layerFromPath(":memory:")
const storeLayer = Store.layer.pipe(Layer.provide(database))
const eff = testEffect(storeLayer)

describe("Ad Engine", () => {
  beforeEach(() => {
    resetFrequencyCaps()
  })

  describe("shouldShowAd", () => {
    it("returns false when ads are disabled regardless of timing (VAL-AD-001)", () => {
      const config = makeConfig({ enabled: false })
      expect(shouldShowAd("thinking", Date.now() - 60_000, 0, config)).toBe(false)
      expect(shouldShowAd("thinking", 0, 100, config)).toBe(false)
    })

    it("returns false when elapsed is strictly less than min_interval_ms (VAL-AD-002)", () => {
      const config = makeConfig({ min_interval_ms: 30_000 })
      // lastAdTime 5s ago, interval is 30s
      expect(shouldShowAd("thinking", Date.now() - 5_000, 0, config)).toBe(false)
    })

    it("returns true at the min_interval_ms boundary (inclusive) (VAL-AD-003)", () => {
      const config = makeConfig({ min_interval_ms: 30_000 })
      // elapsed exactly equals min_interval_ms (gate is strict <)
      expect(shouldShowAd("thinking", Date.now() - 30_000, 0, config)).toBe(true)
    })

    it("returns false when adCountThisHour exceeds max_ads_per_hour (VAL-AD-004)", () => {
      const config = makeConfig({ max_ads_per_hour: 5 })
      expect(shouldShowAd("thinking", Date.now() - 60_000, 10, config)).toBe(false)
    })

    it("returns false when adCountThisHour exactly equals max_ads_per_hour (exclusive boundary) (VAL-AD-005)", () => {
      const config = makeConfig({ max_ads_per_hour: 5 })
      expect(shouldShowAd("thinking", Date.now() - 60_000, 5, config)).toBe(false)
    })

    it("returns true when all gates are satisfied (VAL-AD-006)", () => {
      const config = makeConfig({ min_interval_ms: 30_000, max_ads_per_hour: 5 })
      // elapsed > min, count < max
      expect(shouldShowAd("thinking", Date.now() - 60_000, 4, config)).toBe(true)
    })

    it("restores eligibility after the hourly counter resets to zero (VAL-AD-024)", () => {
      const config = makeConfig({ min_interval_ms: 30_000, max_ads_per_hour: 3 })
      // session at cap
      expect(shouldShowAd("thinking", Date.now() - 60_000, 3, config)).toBe(false)
      // after hourly reset, count is 0
      expect(shouldShowAd("thinking", Date.now() - 60_000, 0, config)).toBe(true)
    })
  })

  describe("selectAd", () => {
    it("cycles through eligible ads round-robin and wraps (VAL-AD-007)", () => {
      const ads = [
        makeAd("rr-1", "rr-adv-1", "devtool"),
        makeAd("rr-2", "rr-adv-2", "devtool"),
        makeAd("rr-3", "rr-adv-3", "devtool"),
      ]
      const config = makeConfig({ frequency_cap: 3 })

      const first = selectAd("thinking", [], ads, config)
      const second = selectAd("thinking", [], ads, config)
      const third = selectAd("thinking", [], ads, config)

      // all three unique ads are returned
      const ids = [first, second, third].map((a) => a!.id)
      expect(new Set(ids).size).toBe(3)

      // wraps back to the first after N calls
      const fourth = selectAd("thinking", [], ads, config)
      expect(fourth!.id).toBe(first!.id)
    })

    it("restricts selection to user-preferred categories (VAL-AD-008)", () => {
      const ads = [
        makeAd("cat-1", "cat-adv-1", "devtool"),
        makeAd("cat-2", "cat-adv-2", "saas"),
      ]
      const config = makeConfig({ frequency_cap: 3 })

      const result = selectAd("thinking", ["devtool"], ads, config)
      expect(result).not.toBeNull()
      expect(result!.category).toBe("devtool")

      const second = selectAd("thinking", ["devtool"], ads, config)
      expect(second!.category).toBe("devtool")
    })

    it("considers all ads eligible when userCategories is empty (VAL-AD-009)", () => {
      const ads = [
        makeAd("all-1", "all-adv-1", "devtool"),
        makeAd("all-2", "all-adv-2", "saas"),
      ]
      const config = makeConfig({ frequency_cap: 3 })

      const seen = new Set<string>()
      for (let i = 0; i < ads.length; i++) {
        const ad = selectAd("thinking", [], ads, config)
        if (ad) seen.add(ad.category)
      }
      expect(seen.has("devtool")).toBe(true)
      expect(seen.has("saas")).toBe(true)
    })

    it("returns null when no ad matches user categories (VAL-AD-010)", () => {
      const ads = [
        makeAd("nomatch-1", "nomatch-adv-1", "devtool"),
        makeAd("nomatch-2", "nomatch-adv-2", "saas"),
      ]
      const config = makeConfig({ frequency_cap: 3 })

      expect(selectAd("thinking", ["recruiting"], ads, config)).toBeNull()
    })

    it("excludes advertisers over the frequency cap (VAL-AD-011)", () => {
      const ads = [
        makeAd("fcap-1", "fcap-adv-1", "devtool"),
        makeAd("fcap-2", "fcap-adv-2", "devtool"),
      ]
      const config = makeConfig({ frequency_cap: 2 })

      // track 3 impressions for adv-1 (over cap)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)

      const result = selectAd("thinking", [], ads, config)
      expect(result).not.toBeNull()
      expect(result!.advertiser_id).not.toBe(ads[0].advertiser_id)
    })

    it("excludes advertiser at exactly the frequency cap (inclusive boundary) (VAL-AD-012)", () => {
      const ads = [
        makeAd("fcb-1", "fcb-adv-1", "devtool"),
        makeAd("fcb-2", "fcb-adv-2", "devtool"),
      ]
      const config = makeConfig({ frequency_cap: 2 })

      // exactly at cap (count == cap, gate is >=)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)

      const result = selectAd("thinking", [], ads, config)
      expect(result).not.toBeNull()
      expect(result!.advertiser_id).not.toBe(ads[0].advertiser_id)
    })

    it("returns null for an empty ad pool (VAL-AD-013)", () => {
      const config = makeConfig({ frequency_cap: 3 })
      expect(selectAd("thinking", [], [], config)).toBeNull()
    })

    it("returns null when all ads are frequency-capped (VAL-AD-014)", () => {
      const ads = [
        makeAd("acap-1", "acap-adv-1", "devtool"),
        makeAd("acap-2", "acap-adv-2", "devtool"),
      ]
      const config = makeConfig({ frequency_cap: 1 })

      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      trackImpression(ads[1], "thinking", "ses-1", "usr-1", 1000)

      expect(selectAd("thinking", [], ads, config)).toBeNull()
    })
  })

  describe("formatAdAsMarkdown", () => {
    it("includes all display fields (VAL-AD-015)", () => {
      const ad = makeAd("fmt-1", "fmt-adv-1", "devtool")
      const md = formatAdAsMarkdown(ad)
      expect(md).toContain(ad.headline)
      expect(md).toContain(ad.body)
      expect(md).toContain(ad.cta_text)
      expect(md).toContain(ad.cta_url)
      expect(md).toContain(ad.display_url)
    })

    it("emboldens the headline and renders the CTA as a markdown link (VAL-AD-016)", () => {
      const ad = makeAd("fmt-2", "fmt-adv-2", "devtool")
      const md = formatAdAsMarkdown(ad)
      expect(md).toContain(`**${ad.headline}**`)
      expect(md).toContain(`[${ad.cta_text}](${ad.cta_url})`)
    })
  })

  describe("scoreAd (Phase 1 slot-aware targeting)", () => {
    it("scores every category in a slot's affinity set higher than the base (VAL-AD-029)", () => {
      const devtoolAd = makeAd("sc-1", "sc-adv-1", "devtool")
      // thinking affinity includes devtool, so it scores above the 100 base.
      expect(scoreAd(devtoolAd, "thinking", [])).toBe(150)
      // idle affinity does not include devtool, so it stays at the base.
      expect(scoreAd(devtoolAd, "idle", [])).toBe(100)
    })

    it("adds a user-preference bonus on top of the slot affinity bonus (VAL-AD-030)", () => {
      const devtoolAd = makeAd("sc-2", "sc-adv-2", "devtool")
      // thinking affinity (devtool) + user preference (devtool) = 100 + 50 + 25.
      expect(scoreAd(devtoolAd, "thinking", ["devtool"])).toBe(175)
      // user preference alone, no slot affinity: 100 + 25.
      expect(scoreAd(devtoolAd, "idle", ["devtool"])).toBe(125)
    })

    it("selectAd prioritizes an affinity-matched ad before a non-matched one (VAL-AD-031)", () => {
      // saas is in toolgap affinity; recruiting is not. With empty user categories both are
      // eligible, but saas should be picked first in the rotation.
      const saasAd = makeAd("pr-1", "pr-adv-1", "saas")
      const recruitingAd = makeAd("pr-2", "pr-adv-2", "recruiting")
      const config = makeConfig({ frequency_cap: 3 })

      const first = selectAd("toolgap", [], [recruitingAd, saasAd], config)
      expect(first!.id).toBe(saasAd.id)
    })

    it("selectAd still rotates through every eligible ad over a full cycle (VAL-AD-032)", () => {
      const devtoolAd = makeAd("rot-1", "rot-adv-1", "devtool")
      const saasAd = makeAd("rot-2", "rot-adv-2", "saas")
      const config = makeConfig({ frequency_cap: 3 })

      const seen = new Set<string>()
      for (let i = 0; i < 2; i++) {
        const ad = selectAd("toolgap", [], [devtoolAd, saasAd], config)
        if (ad) seen.add(ad.id)
      }
      expect(seen.has(devtoolAd.id)).toBe(true)
      expect(seen.has(saasAd.id)).toBe(true)
    })

    it("different slot types re-prioritize the same pool differently (VAL-AD-033)", () => {
      // education is in thinking affinity; saas is in toolgap affinity. Same two ads, two slots.
      const educationAd = makeAd("sl-1", "sl-adv-1", "education")
      const saasAd = makeAd("sl-2", "sl-adv-2", "saas")
      const config = makeConfig({ frequency_cap: 3 })

      const thinkingPick = selectAd("thinking", [], [saasAd, educationAd], config)
      expect(thinkingPick!.id).toBe(educationAd.id)
    })
  })

  describe("trackImpression", () => {
    it("returns a populated AdImpression matching all inputs (VAL-AD-017)", () => {
      const ad = makeAd("imp-1", "imp-adv-1", "devtool")
      const impression = trackImpression(ad, "toolgap", "ses-123", "usr-456", 5000)

      expect(impression.ad_id).toBe(ad.id)
      expect(impression.slot_type).toBe("toolgap")
      expect(impression.session_id).toBe("ses-123")
      expect(impression.user_id).toBe("usr-456")
      expect(impression.duration_ms).toBe(5000)
      expect(impression.clicked).toBe(false)
      expect(impression.shown_at).toBeGreaterThan(0)
    })

    it("returns a branded AdImpressionID that validates against the schema (VAL-AD-018)", () => {
      const ad = makeAd("imp-2", "imp-adv-2", "devtool")
      const impression = trackImpression(ad, "thinking", "ses-1", "usr-1", 2000)

      // id is a non-empty string constructed via schema make
      expect(typeof impression.id).toBe("string")
      expect(impression.id.length).toBeGreaterThan(0)

      // the full impression validates against the AdImpression schema
      const decoded = Schema.decodeUnknownSync(AdImpression)(impression)
      expect(decoded.id).toBe(impression.id)
      expect(decoded.ad_id).toBe(ad.id)

      // the id validates against the branded AdImpressionID schema
      expect(Schema.decodeUnknownSync(AdImpressionID)(impression.id)).toBe(impression.id)
    })

    it("increments the advertiser frequency counter until capped (VAL-AD-019)", () => {
      const ads = [
        makeAd("ic-1", "ic-adv-1", "devtool"),
        makeAd("ic-2", "ic-adv-2", "devtool"),
      ]
      const config = makeConfig({ frequency_cap: 2 })

      // eligible before any impressions
      const first = selectAd("thinking", [], ads, config)
      expect(first).not.toBeNull()

      // track until cap reached
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)

      // adv-1 now excluded
      const result = selectAd("thinking", [], ads, config)
      expect(result).not.toBeNull()
      expect(result!.advertiser_id).not.toBe(ads[0].advertiser_id)
    })
  })

  describe("resetFrequencyCaps", () => {
    it("clears advertiser counters so capped advertisers become eligible again (VAL-AD-020)", () => {
      const ads = [makeAd("reset-1", "reset-adv-1", "devtool")]
      const config = makeConfig({ frequency_cap: 1 })

      trackImpression(ads[0], "thinking", "ses-1", "usr-1", 1000)
      expect(selectAd("thinking", [], ads, config)).toBeNull()

      resetFrequencyCaps()

      const result = selectAd("thinking", [], ads, config)
      expect(result).not.toBeNull()
      expect(result!.id).toBe(ads[0].id)
    })
  })

  describe("credit constants", () => {
    it("standardizes CREDITS_PER_VIEW=4 and CREDITS_PER_CLICK=100 (VAL-AD-021)", () => {
      expect(CREDITS_PER_VIEW).toBe(4)
      expect(CREDITS_PER_CLICK).toBe(100)
    })
  })

  describe("recordImpression and getImpressionStats (DB-backed)", () => {
    eff.effect("persists impressions durably and stats reflect them (VAL-AD-022)", Effect.gen(function* () {
      yield* clearImpressions()
      const ad = makeAd("store-1", "store-adv-1", "devtool")

      const before = yield* getImpressionStats("ses-store")
      expect(before.total_ads).toBe(0)

      yield* recordImpression(trackImpression(ad, "thinking", "ses-store", "usr-1", 2000))

      const after = yield* getImpressionStats("ses-store")
      expect(after.total_ads).toBe(1)
    }))

    eff.effect("computes credits_earned = views*4 + clicks*100 (VAL-AD-023)", Effect.gen(function* () {
      yield* clearImpressions()
      const ad = makeAd("math-1", "math-adv-1", "devtool")

      // 3 views, 0 clicks
      for (let i = 0; i < 3; i++) {
        yield* recordImpression(trackImpression(ad, "thinking", "ses-math", "usr-1", 2000))
      }

      let stats = yield* getImpressionStats("ses-math")
      expect(stats.total_ads).toBe(3)
      expect(stats.total_clicks).toBe(0)
      expect(stats.credits_earned).toBe(3 * CREDITS_PER_VIEW)

      // record 2 more impressions and click them
      const clickable1 = trackImpression(ad, "thinking", "ses-math", "usr-1", 2000)
      const clickable2 = trackImpression(ad, "thinking", "ses-math", "usr-1", 2000)
      yield* recordImpression(clickable1)
      yield* recordImpression(clickable2)
      yield* recordClick(clickable1.id, "https://example.com/click")
      yield* recordClick(clickable2.id, "https://example.com/click")

      stats = yield* getImpressionStats("ses-math")
      expect(stats.total_ads).toBe(5)
      expect(stats.total_clicks).toBe(2)
      expect(stats.credits_earned).toBe(5 * CREDITS_PER_VIEW + 2 * CREDITS_PER_CLICK)
    }))

    eff.effect("recordClick is a no-op for an unknown impression id", Effect.gen(function* () {
      yield* clearImpressions()
      // Should not throw and should complete without error.
      yield* recordClick("nonexistent-id", "https://example.com/click")
    }))
  })

  describe("dwell trust columns (VAL-AD-028/029)", () => {
    eff.effect("recordImpression stores credited=0 and slot_min_ms (VAL-AD-028)", Effect.gen(function* () {
      yield* clearImpressions()
      const ad = makeAd("trust-1", "trust-adv", "devtool")
      const impression = trackImpression(ad, "toolgap", "ses-trust", "usr-trust", 0)
      yield* recordImpression(impression)

      const store = yield* Store.Service
      const stored = yield* store.getImpression(impression.id)
      expect(stored).not.toBeNull()
      expect(stored!.credited).toBe(false)
      expect(stored!.slot_min_ms).toBe(1000)
    }))

    eff.effect("markCredited flips credited once (VAL-AD-029)", Effect.gen(function* () {
      yield* clearImpressions()
      const ad = makeAd("trust-2", "trust-adv", "devtool")
      const impression = trackImpression(ad, "toolgap", "ses-trust2", "usr-trust2", 0)
      yield* recordImpression(impression)

      const store = yield* Store.Service
      expect(yield* store.markCredited(impression.id)).toBe(true)
      expect(yield* store.markCredited(impression.id)).toBe(false)
      const stored = yield* store.getImpression(impression.id)
      expect(stored!.credited).toBe(true)
    }))
  })

  describe("schema validation", () => {
    it("placeholder ads have valid branded IDs and validate against AdCreative", () => {
      const ads = fetchAds(makeConfig())
      expect(ads.length).toBe(6)
      for (const ad of ads) {
        const decoded = Schema.decodeUnknownSync(AdCreative)(ad)
        expect(decoded.id).toBe(ad.id)
        expect(decoded.advertiser_id).toBe(ad.advertiser_id)
      }
    })
  })
})

// =====================================================================================
// AdSource: remote ad server fetch with placeholder fallback (VAL-AD-025/026/027)
// =====================================================================================

const adSourceLayer = AdSource.layer.pipe(Layer.provide(FetchHttpClient.layer))
const srcEff = testEffect(adSourceLayer)

describe("AdSource (Phase 1 remote fetch)", () => {
  srcEff.live("returns placeholders when no ad server URL is configured (VAL-AD-025)", Effect.gen(function* () {
    const svc = yield* AdSource.Service
    const ads = yield* svc.fetchAds(undefined)
    expect(ads.length).toBe(6)
    // All are the hardcoded placeholder creatives.
    expect(ads[0].id).toBe(AdCreativeID.make("ad-vercel-001"))
  }))

  srcEff.live("falls back to placeholders when the ad server is unreachable (VAL-AD-026)", Effect.gen(function* () {
    const svc = yield* AdSource.Service
    // A port that nothing listens on → immediate connection refused, well under the 5s timeout.
    const ads = yield* svc.fetchAds("http://127.0.0.1:59999")
    expect(ads.length).toBe(6)
    expect(ads[0].id).toBe(AdCreativeID.make("ad-vercel-001"))
  }))

  srcEff.live("fetches real ads from a mock ad server (VAL-AD-027)", Effect.gen(function* () {
    // Spin up a throwaway Bun HTTP server that returns a single ad creative.
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/ads") {
          return new Response(
            JSON.stringify({
              ads: [
                {
                  id: "ad-mock-001",
                  advertiser_id: "mock-co",
                  headline: "Mock Ad Headline",
                  body: "Mock ad body text.",
                  cta_text: "Try it",
                  cta_url: "https://mock.test",
                  display_url: "mock.test",
                  category: "devtool",
                  format: "markdown",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const svc = yield* AdSource.Service
      const ads = yield* svc.fetchAds(`http://localhost:${server.port}`)
      expect(ads.length).toBe(1)
      expect(ads[0].id).toBe(AdCreativeID.make("ad-mock-001"))
      expect(ads[0].headline).toBe("Mock Ad Headline")
      expect(ads[0].advertiser_id).toBe(AdvertiserID.make("mock-co"))
    } finally {
      server.stop()
    }
  }))

  srcEff.live("falls back to placeholders on a non-200 response (VAL-AD-028)", Effect.gen(function* () {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("error", { status: 500 })
      },
    })

    try {
      const svc = yield* AdSource.Service
      const ads = yield* svc.fetchAds(`http://localhost:${server.port}`)
      // filterStatusOk rejects 500, so we fall back to placeholders.
      expect(ads.length).toBe(6)
      expect(ads[0].id).toBe(AdCreativeID.make("ad-vercel-001"))
    } finally {
      server.stop()
    }
  }))
})
