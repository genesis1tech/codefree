import { Effect, Schema } from "effect"
import { Store as AdStore } from "./ad/service"
import { Wallet } from "./wallet"
import {
  AD_VIEW_CREDIT_REWARD,
  AFFILIATE_CLICK_CREDIT_REWARD,
  MAX_DAILY_CREDITS,
} from "./wallet/config"

export class CompleteImpressionResult extends Schema.Class<CompleteImpressionResult>("CodeFree.CompleteImpressionResult")({
  credited: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  balance_credits: Schema.optional(Schema.Number),
}) {}

export class ClickAdResult extends Schema.Class<ClickAdResult>("CodeFree.ClickAdResult")({
  credited: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  balance_credits: Schema.optional(Schema.Number),
}) {}

function exceedsDailyCap(earnedToday: number, reward: number) {
  return earnedToday + reward > MAX_DAILY_CREDITS
}

/**
 * Applies a usage cost against the user's wallet, debiting the covered portion and
 * returning the uncovered USD remainder (always >= 0).
 */
export const applyUsage = Effect.fn("CodeFree.applyUsage")(function* (userId: string, costUSD: number) {
  if (costUSD <= 0) return 0

  const creditsNeeded = Wallet.usdToCredits(costUSD)
  const svc = yield* Wallet.Service

  const wallet = yield* svc.getBalance(userId).pipe(
    Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
  )
  const availableCredits = wallet?.balanceCredits ?? 0

  const creditsDebited = Math.min(creditsNeeded, availableCredits)
  if (creditsDebited > 0) {
    yield* svc.debitWallet(userId, creditsDebited, `API usage coverage`, userId)
  }

  const uncoveredCredits = Math.max(0, creditsNeeded - creditsDebited)
  return Wallet.creditsToUsd(uncoveredCredits)
})

export const completeImpression = Effect.fn("CodeFree.completeImpression")(function* (
  userId: string,
  impressionId: string,
  adHeadline = "Ad view",
) {
  const adStore = yield* AdStore.Service
  const wallet = yield* Wallet.Service

  const impression = yield* adStore.getImpression(impressionId)
  if (!impression) return new CompleteImpressionResult({ credited: false, reason: "unknown" })
  if (impression.credited) return new CompleteImpressionResult({ credited: false, reason: "duplicate" })

  const elapsed = Date.now() - impression.shown_at
  if (elapsed < impression.slot_min_ms - 500) {
    return new CompleteImpressionResult({ credited: false, reason: "too_fast" })
  }

  const earnedToday = yield* wallet.getEarnedToday(userId)
  if (exceedsDailyCap(earnedToday, AD_VIEW_CREDIT_REWARD)) {
    return new CompleteImpressionResult({ credited: false, reason: "daily_cap" })
  }

  const marked = yield* adStore.markCredited(impressionId)
  if (!marked) return new CompleteImpressionResult({ credited: false, reason: "duplicate" })

  const credited = yield* wallet.creditWallet(
    userId,
    AD_VIEW_CREDIT_REWARD,
    "ad_view",
    `Ad view credit: ${adHeadline}`,
    impressionId,
  )
  return new CompleteImpressionResult({ credited: true, balance_credits: credited.balanceCredits })
})

export const creditAdClick = Effect.fn("CodeFree.creditAdClick")(function* (
  userId: string,
  impressionId: string,
  adHeadline = "Ad click",
) {
  const wallet = yield* Wallet.Service

  const earnedToday = yield* wallet.getEarnedToday(userId)
  if (exceedsDailyCap(earnedToday, AFFILIATE_CLICK_CREDIT_REWARD)) {
    return new ClickAdResult({ credited: false, reason: "daily_cap" })
  }

  const credited = yield* wallet.creditWallet(
    userId,
    AFFILIATE_CLICK_CREDIT_REWARD,
    "affiliate_click",
    `Ad click credit: ${adHeadline}`,
    impressionId,
  )
  return new ClickAdResult({ credited: true, balance_credits: credited.balanceCredits })
})
