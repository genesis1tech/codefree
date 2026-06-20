import { Effect, Context, Layer, Option, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Wallet } from "@opencode-ai/core/wallet"
import { AdConfig, AdCreative, CREDITS_PER_VIEW, SLOT_MIN_DURATIONS } from "@opencode-ai/core/ad/types"
import { shouldShowAd, selectAd, formatAdAsMarkdown, trackImpression } from "@opencode-ai/core/ad/injector"
import { fetchAds, recordImpression } from "@opencode-ai/core/ad/service"
import { AD_VIEW_CREDIT_REWARD } from "@opencode-ai/core/wallet/config"
import { Account } from "@/account/account"
import { PartID } from "./schema"

type AdSlotType = "thinking" | "toolgap" | "idle"

// Per-session ad tracking state
const lastAdTimes: Record<string, number> = {}
const adCountsThisHour: Record<string, number> = {}
let hourlyResetTimer: ReturnType<typeof setInterval> | undefined

// Reset hourly counters at the top of each hour
if (!hourlyResetTimer) {
  const msUntilNextHour = (60 - new Date().getMinutes()) * 60 * 1000
  hourlyResetTimer = setInterval(() => {
    for (const key of Object.keys(adCountsThisHour)) {
      delete adCountsThisHour[key]
    }
  }, msUntilNextHour)
  hourlyResetTimer.unref()
}

function getLastAdTime(sessionID: string): number {
  return lastAdTimes[sessionID] ?? 0
}

function getAdCountThisHour(sessionID: string): number {
  return adCountsThisHour[sessionID] ?? 0
}

function incrementAdCount(sessionID: string): void {
  adCountsThisHour[sessionID] = getAdCountThisHour(sessionID) + 1
}

function resolveUserID(): Effect.Effect<string | undefined> {
  return Account.Service.pipe(
    Effect.flatMap((svc) => svc.active()),
    Effect.map((opt) => {
      if (Option.isSome(opt)) return opt.value.id
      return undefined
    }),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )
}

// --- Interface ---

export interface Interface {
  readonly maybeShowAd: (
    sessionID: string,
    messageID: string,
    slotType: AdSlotType,
    publishPart: (part: SessionV1.TextPart) => Effect.Effect<SessionV1.TextPart>,
  ) => Effect.Effect<void>
  readonly applyUsage: (
    sessionID: string,
    costUSD: number,
  ) => Effect.Effect<number>
}

// --- Service ---

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeFree") {}

// --- Layer ---

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      maybeShowAd: Effect.fn("CodeFree.maybeShowAd")(function* (sessionID, messageID, slotType, publishPart) {
        const adConfig = AdConfig.defaults

        // Ads must be enabled — skip entirely if disabled
        if (!adConfig.enabled) return

        const lastAdTime = getLastAdTime(sessionID)
        const countThisHour = getAdCountThisHour(sessionID)

        if (!shouldShowAd(slotType, lastAdTime, countThisHour, adConfig)) return

        const availableAds = fetchAds(adConfig)
        const ad = selectAd(slotType, adConfig.categories, availableAds, adConfig)
        if (!ad) return

        // Get user ID for impression tracking and wallet credit
        const userID = yield* resolveUserID()

        const markdown = formatAdAsMarkdown(ad)

        // Publish ad as a text part to the session stream
        yield* publishPart({
          id: PartID.ascending(),
          messageID,
          sessionID,
          type: "text",
          text: markdown,
          synthetic: true,
          time: { start: Date.now(), end: Date.now() },
        })

        // Record impression and credit wallet
        const impression = trackImpression(
          ad,
          slotType,
          sessionID,
          userID ?? "anonymous",
          Date.now() - lastAdTime,
        )
        recordImpression(impression)

        if (userID) {
          yield* Wallet.Service.pipe(
            Effect.flatMap((svc) =>
              svc.creditWallet(
                userID,
                AD_VIEW_CREDIT_REWARD,
                "ad_view",
                `Ad view credit: ${ad.headline}`,
                impression.id,
              ),
            ),
            Effect.catchAll((err) =>
              Effect.logWarning("CodeFree: failed to credit wallet for ad view", err),
            ),
          )
        }

        lastAdTimes[sessionID] = Date.now()
        incrementAdCount(sessionID)
      }),

      applyUsage: Effect.fn("CodeFree.applyUsage")(function* (sessionID, costUSD) {
        if (costUSD <= 0) return 0

        const creditsNeeded = Wallet.usdToCredits(costUSD)
        const userID = yield* resolveUserID()

        // If no account, user pays full price
        if (!userID) return costUSD

        const svc = yield* Wallet.Service

        // Try to debit — if insufficient balance, InsufficientBalanceError is thrown
        const result = yield* svc.debitWallet(
          userID,
          creditsNeeded,
          `API usage for session ${sessionID}`,
          sessionID,
        )

        // Calculate how much was actually covered
        // If debit succeeded, wallet covered the full amount
        // The debitWallet only succeeds if balance >= amount
        return 0
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Wallet.defaultLayer), Layer.provide(Account.defaultLayer))

export * as CodeFree from "."
