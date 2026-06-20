export * as ConfigCodefree from "./codefree"

import { Schema } from "effect"

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
  show_wallet_indicator: true,
  auto_dismiss_ms: 8000,
}
