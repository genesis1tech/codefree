import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/codefree"

export const ClickPayload = Schema.Struct({
  click_url: Schema.String,
})

export const PreferencesPayload = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(Schema.String),
})

export const WithdrawPayload = Schema.Struct({
  amount_credits: Schema.Number,
})

export const CompleteImpressionResult = Schema.Struct({
  credited: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  balance_credits: Schema.optional(Schema.Number),
})

export const ClickResult = Schema.Struct({
  credited: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  balance_credits: Schema.optional(Schema.Number),
})

export const WalletSummary = Schema.Struct({
  balance_credits: Schema.Number,
  lifetime_earned: Schema.Number,
  earned_today: Schema.Number,
  ads_today: Schema.Number,
  clicks_today: Schema.Number,
})

export const PreferencesResult = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(Schema.String),
})

export const WithdrawResult = Schema.Struct({
  status: Schema.String,
  message: Schema.optional(Schema.String),
  min: Schema.optional(Schema.Number),
  refunded: Schema.optional(Schema.Boolean),
  balance_usd: Schema.optional(Schema.Number),
})

export const CodefreePaths = {
  completeImpression: `${root}/impression/:impressionID/complete`,
  clickImpression: `${root}/impression/:impressionID/click`,
  walletSummary: `${root}/wallet/summary`,
  preferences: `${root}/preferences`,
  withdraw: `${root}/withdraw`,
} as const

export const CodefreeApi = HttpApi.make("codefree")
  .add(
    HttpApiGroup.make("codefree")
      .add(
        HttpApiEndpoint.post("completeImpression", CodefreePaths.completeImpression, {
          params: { impressionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(CompleteImpressionResult, "Impression completion result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codefree.impression.complete",
            summary: "Complete ad impression",
            description: "Verify dwell time and credit the user for an ad view.",
          }),
        ),
        HttpApiEndpoint.post("clickImpression", CodefreePaths.clickImpression, {
          params: { impressionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ClickPayload,
          success: described(ClickResult, "Ad click result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codefree.impression.click",
            summary: "Record ad click",
            description: "Record an ad click and credit the user.",
          }),
        ),
        HttpApiEndpoint.get("walletSummary", CodefreePaths.walletSummary, {
          query: WorkspaceRoutingQuery,
          success: described(WalletSummary, "Wallet summary"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codefree.wallet.summary",
            summary: "Wallet summary",
            description: "Get wallet balance and today's ad stats.",
          }),
        ),
        HttpApiEndpoint.put("updatePreferences", CodefreePaths.preferences, {
          query: WorkspaceRoutingQuery,
          payload: PreferencesPayload,
          success: described(PreferencesResult, "Updated preferences"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codefree.preferences.update",
            summary: "Update ad preferences",
            description: "Persist ad preferences for the current user.",
          }),
        ),
        HttpApiEndpoint.post("withdraw", CodefreePaths.withdraw, {
          query: WorkspaceRoutingQuery,
          payload: WithdrawPayload,
          success: described(WithdrawResult, "Withdrawal result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "codefree.withdraw",
            summary: "Withdraw credits",
            description: "Redeem credits via the configured gateway.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "codefree",
          description: "CodeFree ad economy routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
