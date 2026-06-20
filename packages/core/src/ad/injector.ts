import { AdCreative, AdConfig, AdImpression, AdImpressionID } from "./types"

type AdSlotType = "thinking" | "toolgap" | "idle"

// Phase 0 round-robin state
let roundRobinIndex = 0

// Per-advertiser impression counters for frequency capping (reset hourly).
const advertiserCounts: Record<string, number> = {}

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
 * Selects an ad from the available pool using round-robin (Phase 0).
 * Filters by user category preferences and frequency cap.
 */
export function selectAd(
  _slotType: AdSlotType,
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

  const ad = eligible[roundRobinIndex % eligible.length]
  roundRobinIndex = (roundRobinIndex + 1) % eligible.length
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
  })
}

/**
 * Resets the per-advertiser frequency cap counters.
 * Should be called at the top of each hour.
 */
export function resetFrequencyCaps(): void {
  for (const key of Object.keys(advertiserCounts)) {
    delete advertiserCounts[key]
  }
}
