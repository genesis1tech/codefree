import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Wallet } from "@opencode-ai/core/wallet"
import { ConfigCodefree } from "@opencode-ai/core/config/codefree"
import { AdConfig } from "@opencode-ai/core/ad/types"
import { shouldShowAd } from "@opencode-ai/core/ad/injector"
import { applyUsage } from "@opencode-ai/core/codefree"
import { testEffect } from "./lib/effect"

// In-memory database provisioned with the wallet tables via the fresh-DB schema snapshot.
const database = Database.layerFromPath(":memory:")
const walletLayer = Wallet.layer.pipe(Layer.provide(database))
const eff = testEffect(walletLayer)

// --- Config merge helpers ---

const DEFAULT_CATEGORIES = ConfigCodefree.defaults.categories

describe("Config merge (ConfigCodefree.toAdConfig)", () => {
  describe("overlay & fallback", () => {
    it("overlays user-specified fields over defaults (VAL-USAGE-001)", () => {
      const merged = ConfigCodefree.toAdConfig(
        new ConfigCodefree.Info({ enabled: true, max_ads_per_hour: 10, frequency_cap: 7 }),
      )
      expect(merged.enabled).toBe(true)
      expect(merged.max_ads_per_hour).toBe(10)
      expect(merged.frequency_cap).toBe(7)
    })

    it("falls back to defaults for omitted fields (VAL-USAGE-002)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true }))
      // enabled overridden, the rest fall back to ConfigCodefree.defaults
      expect(merged.enabled).toBe(true)
      expect(merged.min_interval_ms).toBe(ConfigCodefree.defaults.min_interval_ms)
      expect(merged.max_ads_per_hour).toBe(ConfigCodefree.defaults.max_ads_per_hour)
      expect(merged.frequency_cap).toBe(ConfigCodefree.defaults.frequency_cap)
    })

    it("falls back to defaults for an entirely empty user block (VAL-USAGE-002/003)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({}))
      expect(merged.enabled).toBe(ConfigCodefree.defaults.enabled)
      expect(merged.min_interval_ms).toBe(ConfigCodefree.defaults.min_interval_ms)
      expect(merged.max_ads_per_hour).toBe(ConfigCodefree.defaults.max_ads_per_hour)
      expect(merged.frequency_cap).toBe(ConfigCodefree.defaults.frequency_cap)
    })
  })

  describe("empty / undefined user block", () => {
    it("undefined user block yields the full ConfigCodefree.defaults as AdConfig (VAL-USAGE-003)", () => {
      const merged = ConfigCodefree.toAdConfig(undefined)
      expect(merged.enabled).toBe(ConfigCodefree.defaults.enabled)
      expect(merged.min_interval_ms).toBe(ConfigCodefree.defaults.min_interval_ms)
      expect(merged.max_ads_per_hour).toBe(ConfigCodefree.defaults.max_ads_per_hour)
      expect(merged.categories as readonly string[]).toEqual(ConfigCodefree.defaults.categories)
      expect(merged.frequency_cap).toBe(ConfigCodefree.defaults.frequency_cap)
    })

    it("empty user block yields the full ConfigCodefree.defaults as AdConfig (VAL-USAGE-003)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({}))
      expect(merged.enabled).toBe(ConfigCodefree.defaults.enabled)
      expect(merged.categories as readonly string[]).toEqual(ConfigCodefree.defaults.categories)
    })
  })

  describe("complete engine-consumable AdConfig", () => {
    it("merged config is a complete AdConfig accepted by the engine (VAL-USAGE-004)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true, max_ads_per_hour: 3 }))

      // Every engine-required field is defined.
      expect(merged.enabled).toBeDefined()
      expect(merged.min_interval_ms).toBeDefined()
      expect(merged.max_ads_per_hour).toBeDefined()
      expect(merged.categories).toBeDefined()
      expect(merged.frequency_cap).toBeDefined()

      // The merged object is an AdConfig instance usable directly by the engine.
      expect(merged).toBeInstanceOf(AdConfig)

      // Engine consumption: shouldShowAd reads enabled/min_interval/cap without error.
      // With enabled true and a long-ago lastAdTime, it should return true.
      expect(shouldShowAd("toolgap", 0, 0, merged)).toBe(true)
    })

    it("all engine-required fields are defined for an empty user block (VAL-USAGE-004)", () => {
      const merged = ConfigCodefree.toAdConfig(undefined)
      expect(typeof merged.enabled).toBe("boolean")
      expect(typeof merged.min_interval_ms).toBe("number")
      expect(typeof merged.max_ads_per_hour).toBe("number")
      expect(Array.isArray(merged.categories)).toBe(true)
      expect(typeof merged.frequency_cap).toBe("number")
    })
  })

  describe("categories override", () => {
    it("user categories replace (not append) default categories (VAL-USAGE-005)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ categories: ["devtool", "saas"] }))
      // The user list replaces the defaults entirely.
      expect(merged.categories).toEqual(["devtool", "saas"])
      // Default categories that are not in the user list are absent.
      expect(merged.categories).not.toContain("recruiting")
    })

    it("a single-element user category list is honored exactly (VAL-USAGE-005)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ categories: ["education"] }))
      expect(merged.categories).toEqual(["education"])
    })

    it("omitted categories fall back to the full default list (VAL-USAGE-005)", () => {
      const merged = ConfigCodefree.toAdConfig(new ConfigCodefree.Info({ enabled: true }))
      expect(merged.categories as readonly string[]).toEqual(DEFAULT_CATEGORIES)
    })
  })
})

describe("applyUsage accounting", () => {
  describe("full coverage", () => {
    eff.effect("returns 0 and debits usdToCredits(costUSD) when balance fully covers cost (VAL-USAGE-006)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // Seed 100 credits ($1.00), cost $0.40 = 40 credits.
        yield* svc.creditWallet("user-full", 100, "bonus", "seed")
        const before = yield* svc.getBalance("user-full")
        expect(before.balanceCredits).toBe(100)

        const uncovered = yield* applyUsage("user-full", 0.4)
        expect(uncovered).toBe(0)

        const after = yield* svc.getBalance("user-full")
        expect(after.balanceCredits).toBe(60) // 100 - usdToCredits(0.4) = 100 - 40
        expect(after.lifetimeSpentCredits).toBe(40)
      }),
    )
  })

  describe("no balance", () => {
    eff.effect("returns the full costUSD and debits nothing on zero balance (VAL-USAGE-007)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // Provision a wallet with zero balance.
        yield* svc.getOrCreateWallet("user-zero")

        const uncovered = yield* applyUsage("user-zero", 0.5)
        expect(uncovered).toBe(0.5)

        const after = yield* svc.getBalance("user-zero")
        expect(after.balanceCredits).toBe(0)
        const history = yield* svc.getTransactionHistory("user-zero")
        expect(history.length).toBe(0)
      }),
    )
  })

  describe("partial coverage", () => {
    eff.effect("returns the uncovered remainder and debits only the available credits (VAL-USAGE-008)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // Seed 4 credits ($0.04), cost $0.10 = 10 credits.
        yield* svc.creditWallet("user-partial", 4, "bonus", "seed")

        const uncovered = yield* applyUsage("user-partial", 0.1)
        // uncovered = creditsToUsd(creditsNeeded - debited) = creditsToUsd(10 - 4) = creditsToUsd(6) = 0.06
        expect(uncovered).toBeCloseTo(0.06, 10)

        const after = yield* svc.getBalance("user-partial")
        expect(after.balanceCredits).toBe(0)
      }),
    )

    eff.effect("debits exactly min(usdToCredits(costUSD), available) on partial coverage (VAL-USAGE-009)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // Seed 7 credits, cost $0.20 = 20 credits. min(20, 7) = 7 debited.
        yield* svc.creditWallet("user-min", 7, "bonus", "seed")

        yield* applyUsage("user-min", 0.2)

        const after = yield* svc.getBalance("user-min")
        expect(after.balanceCredits).toBe(0)
        expect(after.lifetimeSpentCredits).toBe(7)

        const history = yield* svc.getTransactionHistory("user-min")
        const debit = history.find((r) => r.amountCredits < 0)
        expect(debit).toBeDefined()
        expect(debit!.amountCredits).toBe(-7)
      }),
    )
  })

  describe("zero / negative cost", () => {
    eff.effect("returns 0 and performs no debit for zero cost (VAL-USAGE-010)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        yield* svc.creditWallet("user-zero-cost", 50, "bonus", "seed")

        const uncovered = yield* applyUsage("user-zero-cost", 0)
        expect(uncovered).toBe(0)

        const after = yield* svc.getBalance("user-zero-cost")
        expect(after.balanceCredits).toBe(50)
      }),
    )

    eff.effect("returns 0 (clamped) and performs no debit for negative cost (VAL-USAGE-011)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        yield* svc.creditWallet("user-neg-cost", 50, "bonus", "seed")

        const uncovered = yield* applyUsage("user-neg-cost", -0.5)
        expect(uncovered).toBe(0)

        const after = yield* svc.getBalance("user-neg-cost")
        expect(after.balanceCredits).toBe(50)
      }),
    )
  })

  describe("remainder clamp & rounding", () => {
    eff.effect("uncovered remainder is never negative across coverage cases (VAL-USAGE-012)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service

        // Over-covered: balance exceeds cost.
        yield* svc.creditWallet("user-over", 1000, "bonus", "seed")
        const overCovered = yield* applyUsage("user-over", 0.01)
        expect(overCovered).toBeGreaterThanOrEqual(0)

        // Partial coverage.
        yield* svc.creditWallet("user-partial-clamp", 2, "bonus", "seed")
        const partial = yield* applyUsage("user-partial-clamp", 5)
        expect(partial).toBeGreaterThanOrEqual(0)

        // No balance.
        yield* svc.getOrCreateWallet("user-nobal-clamp")
        const none = yield* applyUsage("user-nobal-clamp", 3)
        expect(none).toBeGreaterThanOrEqual(0)
        expect(none).toBe(3)
      }),
    )

    eff.effect("converts cost to credits with round-half-up, 0.045 needs 5 credits (VAL-USAGE-013)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // usdToCredits(0.045) = round(4.5) = 5 credits. Balance of exactly 5 fully covers it.
        yield* svc.creditWallet("user-round", 5, "bonus", "seed")

        const uncovered = yield* applyUsage("user-round", 0.045)
        expect(uncovered).toBe(0)

        const after = yield* svc.getBalance("user-round")
        expect(after.balanceCredits).toBe(0)
      }),
    )

    eff.effect("rounding boundary: 0.015 needs 2 credits, balance 1 is partial (VAL-USAGE-013)", () =>
      Effect.gen(function* () {
        const svc = yield* Wallet.Service
        // usdToCredits(0.015) = round(1.5) = 2 credits. Balance 1 => debit 1, uncovered = creditsToUsd(1) = 0.01.
        yield* svc.creditWallet("user-round2", 1, "bonus", "seed")

        const uncovered = yield* applyUsage("user-round2", 0.015)
        expect(uncovered).toBeCloseTo(0.01, 10)

        const after = yield* svc.getBalance("user-round2")
        expect(after.balanceCredits).toBe(0)
      }),
    )
  })
})
