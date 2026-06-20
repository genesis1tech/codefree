import { Schema } from "effect"

// -- ID types --

const AdCreativeID = Schema.String.pipe(Schema.brand("AdCreativeID"))
const AdSlotID = Schema.String.pipe(Schema.brand("AdSlotID"))
const AdImpressionID = Schema.String.pipe(Schema.brand("AdImpressionID"))
const AdvertiserID = Schema.String.pipe(Schema.brand("AdvertiserID"))

// -- Enums --

const AdCategory = Schema.Literal("devtool", "saas", "recruiting", "education", "affiliate")
type AdCategoryType = typeof AdCategory.Type
const AdFormat = Schema.Literal("text", "markdown")
const SlotType = Schema.Literal("thinking", "toolgap", "idle")
const SlotPosition = Schema.Literal("top", "bottom", "inline")

// -- Core types --

export class AdCreative extends Schema.Class<AdCreative>("AdCreative")({
  id: AdCreativeID,
  advertiser_id: AdvertiserID,
  headline: Schema.String,
  body: Schema.String,
  cta_text: Schema.String,
  cta_url: Schema.String,
  display_url: Schema.String,
  category: AdCategory,
  format: AdFormat,
  image_url: Schema.optional(Schema.String),
}) {}

export class AdSlot extends Schema.Class<AdSlot>("AdSlot")({
  id: AdSlotID,
  type: SlotType,
  position: SlotPosition,
  min_duration_ms: Schema.Number,
}) {}

export class AdImpression extends Schema.Class<AdImpression>("AdImpression")({
  id: AdImpressionID,
  ad_id: AdCreativeID,
  slot_type: SlotType,
  session_id: Schema.String,
  user_id: Schema.String,
  shown_at: Schema.Number,
  duration_ms: Schema.Number,
  clicked: Schema.Boolean,
  click_url: Schema.optional(Schema.String),
}) {}

export class AdConfig extends Schema.Class<AdConfig>("AdConfig")({
  enabled: Schema.Boolean,
  min_interval_ms: Schema.Number,
  max_ads_per_hour: Schema.Number,
  categories: Schema.Array(AdCategory),
  frequency_cap: Schema.Number,
}) {
  static defaults = {
    enabled: true,
    min_interval_ms: 30_000,
    max_ads_per_hour: 25,
    categories: [] as ReadonlyArray<AdCategoryType>,
    frequency_cap: 3,
  }
}

export class ImpressionStats extends Schema.Class<ImpressionStats>("AdImpressionStats")({
  total_ads: Schema.Number,
  total_clicks: Schema.Number,
  credits_earned: Schema.Number,
}) {}

// -- Constants --

export const CREDITS_PER_VIEW = 4
export const CREDITS_PER_CLICK = 100
export const SLOT_MIN_DURATIONS = {
  thinking: 2_000,
  toolgap: 1_000,
  idle: 5_000,
} as const
