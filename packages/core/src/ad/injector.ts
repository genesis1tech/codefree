import { AdCreative, AdConfig, AdImpression, AdImpressionID, SLOT_MIN_DURATIONS } from "./types"

type AdSlotType = "thinking" | "toolgap" | "idle"

// Round-robin cursor over the score-sorted eligible pool.
let roundRobinIndex = 0

// Per-advertiser impression counters for frequency capping (reset hourly).
const advertiserCounts: Record<string, number> = {}

// Slot-type -> category affinity. Ads whose category matches the active slot's affinity set get a
// priority boost so the right creative reaches the right dwell context: longer "thinking" pauses
// suit dev/educational content, quick "toolgap" bursts suit dev tools and SaaS, and "idle" time
// suits lower-intent affiliate/recruiting/education placements.
export const SLOT_CATEGORY_AFFINITY: Record<AdSlotType, ReadonlyArray<string>> = {
  thinking: ["devtool", "education"],
  toolgap: ["devtool", "saas"],
  idle: ["affiliate", "recruiting", "education"],
}

const SLOT_AFFINITY_BONUS = 50

/**
 * Computes a priority score for an eligible ad within a slot. Higher = picked earlier in the
 * round-robin rotation. Pure function: same inputs always yield the same score, so the rotation
 * stays deterministic. The slot-affinity bonus is the Phase 1 targeting signal that the Phase 0
 * round-robin ignored (`_slotType` was unused).
 */
export function scoreAd(
  ad: AdCreative,
  slotType: AdSlotType,
  userCategories: ReadonlyArray<string>,
): number {
  let score = 100
  if (SLOT_CATEGORY_AFFINITY[slotType].includes(ad.category)) score += SLOT_AFFINITY_BONUS
  // A soft user-preference signal layered on top of the hard category filter. When the user has
  // not expressed preferences (empty list) every ad is treated equally here; the hard filter in
  // selectAd still enforces preference when a list is set.
  if (userCategories.length > 0 && userCategories.includes(ad.category)) score += 25
  return score
}

/**
 * Determines whether an ad should be shown given current timing and caps.
 */
export function shouldShowAd(
  _slotType: AdSlotType,
  lastAdTime: number,
  adCountThisHour: number,
  config: AdConfig,
): boolean {
  if (!config.enabled) return false

  const now = Date.now()
  const elapsed = now - lastAdTime

  if (elapsed < config.min_interval_ms) return false
  if (adCountThisHour >= config.max_ads_per_hour) return false

  return true
}

/**
 * Selects an ad from the available pool. Phase 1 adds slot-aware scoring: eligible ads are
 * stable-sorted by scoreAd (slot affinity + user preference) so better-fitting creatives are
 * rotated in first, then round-robin cycles through the full sorted pool so every eligible ad
 * still gets impressions. Returns null when no ad is eligible.
 */
export function selectAd(
  slotType: AdSlotType,
  userCategories: ReadonlyArray<string>,
  availableAds: ReadonlyArray<AdCreative>,
  config: AdConfig,
): AdCreative | null {
  const eligible = availableAds.filter((ad) => {
    if (!userCategories.includes(ad.category) && userCategories.length > 0) return false
    if ((advertiserCounts[ad.advertiser_id] ?? 0) >= config.frequency_cap) return false
    return true
  })

  if (eligible.length === 0) return null

  // Stable sort by descending score: equal-score ads keep their original relative order so the
  // rotation over a single-category pool is identical to the Phase 0 round-robin.
  const sorted = [...eligible].sort(
    (a, b) => scoreAd(b, slotType, userCategories) - scoreAd(a, slotType, userCategories),
  )

  const ad = sorted[roundRobinIndex % sorted.length]
  roundRobinIndex = (roundRobinIndex + 1) % sorted.length
  return ad
}

/**
 * Renders an ad as a non-intrusive markdown block for TUI display.
 */
export function formatAdAsMarkdown(ad: AdCreative): string {
  const lines = [
    "",
    `  💡 **${ad.headline}**`,
    `  ${ad.body}`,
    `  [${ad.cta_text}](${ad.cta_url})  ·  ${ad.display_url}`,
    "",
  ]
  return lines.join("\n")
}

/**
 * Records an impression locally and increments the advertiser counter
 * for frequency capping. Returns the AdImpression for persistence.
 */
export function trackImpression(
  ad: AdCreative,
  slotType: AdSlotType,
  sessionId: string,
  userId: string,
  durationMs: number,
): AdImpression {
  advertiserCounts[ad.advertiser_id] = (advertiserCounts[ad.advertiser_id] ?? 0) + 1

  return new AdImpression({
    id: AdImpressionID.make(crypto.randomUUID()),
    ad_id: ad.id,
    slot_type: slotType,
    session_id: sessionId,
    user_id: userId,
    shown_at: Date.now(),
    duration_ms: durationMs,
    clicked: false,
    credited: false,
    slot_min_ms: SLOT_MIN_DURATIONS[slotType],
  })
}

/**
 * Resets the per-advertiser frequency cap counters and the round-robin cursor.
 * Should be called at the top of each hour.
 */
export function resetFrequencyCaps(): void {
  for (const key of Object.keys(advertiserCounts)) {
    delete advertiserCounts[key]
  }
  roundRobinIndex = 0
}
