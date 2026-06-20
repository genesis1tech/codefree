import { beforeEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
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
import { formatAdAsMarkdown, resetFrequencyCaps, selectAd, shouldShowAd, trackImpression } from "@opencode-ai/core/ad/injector"
import { clearImpressions, fetchAds, getImpressionStats, recordClick, recordImpression } from "@opencode-ai/core/ad/service"

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

describe("Ad Engine", () => {
  beforeEach(() => {
    resetFrequencyCaps()
    clearImpressions()
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

  describe("recordImpression and getImpressionStats", () => {
    it("stores impressions in the in-memory store (VAL-AD-022)", () => {
      const ad = makeAd("store-1", "store-adv-1", "devtool")

      const before = getImpressionStats("ses-store")
      expect(before.total_ads).toBe(0)

      recordImpression(trackImpression(ad, "thinking", "ses-store", "usr-1", 2000))

      const after = getImpressionStats("ses-store")
      expect(after.total_ads).toBe(1)
    })

    it("computes credits_earned = views*4 + clicks*100 (VAL-AD-023)", () => {
      const ad = makeAd("math-1", "math-adv-1", "devtool")

      // 3 views, 0 clicks
      for (let i = 0; i < 3; i++) {
        recordImpression(trackImpression(ad, "thinking", "ses-math", "usr-1", 2000))
      }

      let stats = getImpressionStats("ses-math")
      expect(stats.total_ads).toBe(3)
      expect(stats.total_clicks).toBe(0)
      expect(stats.credits_earned).toBe(3 * CREDITS_PER_VIEW)

      // record 2 more impressions and click them
      const clickable1 = trackImpression(ad, "thinking", "ses-math", "usr-1", 2000)
      const clickable2 = trackImpression(ad, "thinking", "ses-math", "usr-1", 2000)
      recordImpression(clickable1)
      recordImpression(clickable2)
      recordClick(clickable1.id, "https://example.com/click")
      recordClick(clickable2.id, "https://example.com/click")

      stats = getImpressionStats("ses-math")
      expect(stats.total_ads).toBe(5)
      expect(stats.total_clicks).toBe(2)
      expect(stats.credits_earned).toBe(5 * CREDITS_PER_VIEW + 2 * CREDITS_PER_CLICK)
    })
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
