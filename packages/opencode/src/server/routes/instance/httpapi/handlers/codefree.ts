import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { resolveUserID } from "@/session/codefree"
import { Store as AdStore } from "@opencode-ai/core/ad/service"
import { EventV2 } from "@opencode-ai/core/event"
import { completeImpression as completeImpressionCredits, creditAdClick } from "@opencode-ai/core/codefree"
import { Wallet, Payout } from "@opencode-ai/core/wallet"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ClickPayload, PreferencesPayload, WithdrawPayload } from "../groups/codefree"

const CreditUpdatedEvent = EventV2.define({
  type: "codefree.credit.updated",
  schema: {
    balance_credits: Schema.Number,
    lifetime_earned: Schema.Number,
    lifetime_spent: Schema.Number,
  },
})

export const codefreeHandlers = HttpApiBuilder.group(InstanceHttpApi, "codefree", (handlers) =>
  Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const adStore = yield* AdStore.Service
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const payout = yield* Payout.PayoutService

    const publishCreditUpdated = Effect.fn("CodefreeHttpApi.publishCreditUpdated")(function* (userId: string) {
      const balance = yield* wallet.getBalance(userId).pipe(
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed(null)),
      )
      if (!balance) return
      yield* events.publish(CreditUpdatedEvent, {
        balance_credits: balance.balanceCredits,
        lifetime_earned: balance.lifetimeEarnedCredits,
        lifetime_spent: balance.lifetimeSpentCredits,
      }).pipe(Effect.catch(() => Effect.void))
    })

    const completeImpression = Effect.fn("CodefreeHttpApi.completeImpression")(function* (ctx: {
      params: { impressionID: string }
    }) {
      const userId = yield* resolveUserID()
      const result = yield* completeImpressionCredits(userId, ctx.params.impressionID).pipe(
        Effect.provideService(Wallet.Service, wallet),
        Effect.provideService(AdStore.Service, adStore),
      )
      if (result.credited) yield* publishCreditUpdated(userId)
      return {
        credited: result.credited,
        reason: result.reason,
        balance_credits: result.balance_credits,
      }
    })

    const clickImpression = Effect.fn("CodefreeHttpApi.clickImpression")(function* (ctx: {
      params: { impressionID: string }
      payload: typeof ClickPayload.Type
    }) {
      const userId = yield* resolveUserID()
      const recorded = yield* adStore.recordClick(ctx.params.impressionID, ctx.payload.click_url)
      if (!recorded) return { credited: false, reason: "unknown" }

      const result = yield* creditAdClick(userId, ctx.params.impressionID).pipe(
        Effect.provideService(Wallet.Service, wallet),
      )
      if (result.credited) yield* publishCreditUpdated(userId)
      return {
        credited: result.credited,
        reason: result.reason,
        balance_credits: result.balance_credits,
      }
    })

    const walletSummary = Effect.fn("CodefreeHttpApi.walletSummary")(function* () {
      const userId = yield* resolveUserID()
      const info = yield* wallet.getOrCreateWallet(userId)
      const earnedToday = yield* wallet.getEarnedToday(userId)
      const today = yield* adStore.getTodayStats(userId)
      return {
        balance_credits: info.balanceCredits,
        lifetime_earned: info.lifetimeEarnedCredits,
        earned_today: earnedToday,
        ads_today: today.total_ads,
        clicks_today: today.total_clicks,
      }
    })

    const updatePreferences = Effect.fn("CodefreeHttpApi.updatePreferences")(function* (ctx: {
      payload: typeof PreferencesPayload.Type
    }) {
      const userId = yield* resolveUserID()
      return yield* adStore.upsertPreference(userId, ctx.payload.enabled, ctx.payload.categories)
    })

    const withdraw = Effect.fn("CodefreeHttpApi.withdraw")(function* (ctx: {
      payload: typeof WithdrawPayload.Type
    }) {
      const info = yield* config.get()
      if (!info.codefree?.gateway_url) {
        return { status: "unavailable", message: "configure codefree.gateway_url" }
      }
      const userId = yield* resolveUserID()
      const gatewayUrl = info.codefree.gateway_url
      const withdrawal = yield* payout.requestWithdrawal(userId, ctx.payload.amount_credits, "gateway").pipe(
        Effect.catchTag("BelowMinimumWithdrawalError", (err) =>
          Effect.succeed({ status: "below_minimum", min: err.minimum }),
        ),
        Effect.catchTag("InsufficientBalanceError", () => Effect.succeed({ status: "insufficient" })),
        Effect.catchTag("WalletNotFoundError", () => Effect.succeed({ status: "insufficient" })),
      )
      // WithdrawalRequest itself has a `status` field ("pending"), so discriminate on `id`,
      // which only the successful withdrawal row carries.
      if (!("id" in withdrawal)) return withdrawal

      yield* payout.processWithdrawal(withdrawal.id)
      const usd = Wallet.creditsToUsd(ctx.payload.amount_credits)

      const deposit = yield* Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () =>
            fetch(`${gatewayUrl}/accounts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user_id: userId }),
              signal: AbortSignal.timeout(5000),
            }),
          catch: (error) => new Error(String(error)),
        })
        const response = yield* Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${gatewayUrl}/accounts/${encodeURIComponent(userId)}/deposit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ usd, reference: withdrawal.id }),
              signal: AbortSignal.timeout(5000),
            })
            if (!res.ok) throw new Error(`gateway deposit failed: ${res.status}`)
            return (await res.json()) as { deposit_id: string; balance_usd: number }
          },
          catch: (error) => new Error(String(error)),
        })
        return response
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Timeout after a landed deposit can refund while the gateway credited — reconcile later.
            yield* payout.failWithdrawal(withdrawal.id, error.message)
            return { status: "failed" as const, refunded: true }
          }),
        ),
      )

      if ("status" in deposit) return deposit

      yield* payout.completeWithdrawal(withdrawal.id, deposit.deposit_id)
      return { status: "completed", balance_usd: deposit.balance_usd }
    })

    return handlers
      .handle("completeImpression", completeImpression)
      .handle("clickImpression", clickImpression)
      .handle("walletSummary", walletSummary)
      .handle("updatePreferences", updatePreferences)
      .handle("withdraw", withdraw)
  }),
)
