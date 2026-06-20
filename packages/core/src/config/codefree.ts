export * as ConfigCodefree from "./codefree"

import { Schema } from "effect"
import { AdConfig } from "../ad/types"

export class Info extends Schema.Class<Info>("ConfigV2.Codefree")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable ad-sponsored credit earning (opt-in)",
  }),
  min_interval_ms: Schema.Number.pipe(Schema.optional).annotate({
    description: "Minimum milliseconds between ad impressions",
  }),
  max_ads_per_hour: Schema.Number.pipe(Schema.optional).annotate({
    description: "Maximum number of ad impressions allowed per hour",
  }),
  categories: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Ad categories to show (devtool, saas, recruiting, education, affiliate)",
  }),
  frequency_cap: Schema.Number.pipe(Schema.optional).annotate({
    description: "Maximum impressions per advertiser before frequency capping",
  }),
  show_wallet_indicator: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Show wallet credit balance indicator in the UI",
  }),
  auto_dismiss_ms: Schema.Number.pipe(Schema.optional).annotate({
    description: "Milliseconds before an ad is auto-dismissed",
  }),
}) {}

export const defaults = {
  enabled: false,
  min_interval_ms: 30000,
  max_ads_per_hour: 25,
  categories: ["devtool", "saas", "recruiting", "education", "affiliate"],
  frequency_cap: 3,
  show_wallet_indicator: true,
  auto_dismiss_ms: 8000,
}

/**
 * Overlays a partial user `codefree` block (from opencode.json) over the defaults to
 * produce a complete, engine-consumable AdConfig. User-specified fields override; omitted
 * fields fall back to defaults; the categories array is replaced (not appended). An
 * empty/undefined user block yields the full defaults.
 */
export function toAdConfig(user?: Info): AdConfig {
  return Schema.decodeUnknownSync(AdConfig)({
    enabled: user?.enabled ?? defaults.enabled,
    min_interval_ms: user?.min_interval_ms ?? defaults.min_interval_ms,
    max_ads_per_hour: user?.max_ads_per_hour ?? defaults.max_ads_per_hour,
    categories: user?.categories ?? defaults.categories,
    frequency_cap: user?.frequency_cap ?? defaults.frequency_cap,
  })
}
