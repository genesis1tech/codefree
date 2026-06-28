import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Wallet, Payout } from "@opencode-ai/core/wallet"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const payoutLayer = Payout.layer.pipe(Layer.provide(database))
const walletLayer = Wallet.layer.pipe(Layer.provide(database))
const combined = Layer.mergeAll(payoutLayer, walletLayer)
const eff = testEffect(combined)

const TEST_USER = "wdl_test_user"

function failureOf<E>(effect: Effect.Effect<unknown, E, never>): Effect.Effect<E, never> {
  return effect.pipe(
    Effect.match({
      onFailure: (e) => e,
      onSuccess: () => {
        throw new Error("Expected the effect to fail, but it succeeded")
      },
    }),
  )
}

describe("Payout withdrawal state machine + accounting", () => {
  eff.effect("requestWithdrawal rejects below the minimum threshold (VAL-PAYOUT-001)", Effect.gen(function* () {
    const payout = yield* Payout.PayoutService
    const err = yield* failureOf(payout.requestWithdrawal(TEST_USER, 500))
    expect(err).toBeInstanceOf(Payout.BelowMinimumWithdrawalError)
    expect((err as Payout.BelowMinimumWithdrawalError).minimum).toBe(Payout.MIN_WITHDRAWAL_CREDITS)
  }))

  eff.effect("requestWithdrawal fails when the wallet has insufficient balance (VAL-PAYOUT-002)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService
    // Provision a 0-balance wallet so we hit InsufficientBalanceError, not WalletNotFoundError.
    yield* wallet.getOrCreateWallet(TEST_USER)
    const err = yield* failureOf(payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS))
    expect(err).toBeInstanceOf(Wallet.InsufficientBalanceError)
  }))

  eff.effect("mock requestWithdrawal debits the balance and auto-completes (VAL-PAYOUT-003)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    // Seed enough credits to withdraw.
    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS + 200, "bonus", "seed")

    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "manual")
    expect(withdrawal.status).toBe("completed")
    expect(withdrawal.amountCredits).toBe(Payout.MIN_WITHDRAWAL_CREDITS)
    expect(withdrawal.payoutReference).toBeDefined()

    // Balance should be the leftover 200 credits.
    const balance = yield* wallet.getBalance(TEST_USER)
    expect(balance.balanceCredits).toBe(200)
  }))

  eff.effect("requestWithdrawal records a 'withdrawal' type transaction (VAL-PAYOUT-004)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "bonus", "seed")
    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "manual")

    const history = yield* wallet.getTransactionHistory(TEST_USER)
    const withdrawalTx = history.find((t) => t.type === "withdrawal")
    expect(withdrawalTx).toBeDefined()
    expect(withdrawalTx!.amountCredits).toBe(-Payout.MIN_WITHDRAWAL_CREDITS)
    expect(withdrawalTx!.referenceId).toBe(withdrawal.id)
  }))

  eff.effect("getWithdrawals returns the user's withdrawal history ordered newest-first (VAL-PAYOUT-005)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS * 3, "bonus", "seed")
    yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "manual")
    yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "manual")

    const withdrawals = yield* payout.getWithdrawals(TEST_USER)
    expect(withdrawals.length).toBe(2)
    expect(withdrawals[0].requestedAt).toBeGreaterThanOrEqual(withdrawals[1].requestedAt)
  }))

  eff.effect("cancelWithdrawal refunds escrowed credits with a 'withdrawal_refund' transaction (VAL-PAYOUT-006)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    // Use a non-manual method so the withdrawal stays "pending" (no auto-complete).
    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "bonus", "seed")
    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "stripe")

    // Balance is 0 after the escrow debit.
    let balance = yield* wallet.getBalance(TEST_USER)
    expect(balance.balanceCredits).toBe(0)

    const cancelled = yield* payout.cancelWithdrawal(withdrawal.id, TEST_USER)
    expect(cancelled.status).toBe("cancelled")

    // Balance should be refunded back to the full amount.
    balance = yield* wallet.getBalance(TEST_USER)
    expect(balance.balanceCredits).toBe(Payout.MIN_WITHDRAWAL_CREDITS)

    // A refund transaction was recorded.
    const history = yield* wallet.getTransactionHistory(TEST_USER)
    const refundTx = history.find((t) => t.type === "withdrawal_refund")
    expect(refundTx).toBeDefined()
    expect(refundTx!.amountCredits).toBe(Payout.MIN_WITHDRAWAL_CREDITS)
  }))

  eff.effect("failWithdrawal refunds escrowed credits and records the failure reason (VAL-PAYOUT-007)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "bonus", "seed")
    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "paypal")

    // Move to processing first (simulate provider attempting payout).
    yield* payout.processWithdrawal(withdrawal.id)

    const failed = yield* payout.failWithdrawal(withdrawal.id, "provider rejected account")
    expect(failed.status).toBe("failed")
    expect(failed.failureReason).toBe("provider rejected account")

    // Balance refunded.
    const balance = yield* wallet.getBalance(TEST_USER)
    expect(balance.balanceCredits).toBe(Payout.MIN_WITHDRAWAL_CREDITS)
  }))

  eff.effect("cancelWithdrawal rejects a non-pending withdrawal (VAL-PAYOUT-008)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "bonus", "seed")
    // manual auto-completes, so it's no longer "pending".
    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "manual")

    const err = yield* failureOf(payout.cancelWithdrawal(withdrawal.id, TEST_USER))
    expect(err).toBeInstanceOf(Payout.InvalidWithdrawalStateError)
  }))

  eff.effect("completeWithdrawal only transitions from 'processing' (VAL-PAYOUT-009)", Effect.gen(function* () {
    const wallet = yield* Wallet.Service
    const payout = yield* Payout.PayoutService

    yield* wallet.creditWallet(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "bonus", "seed")
    const withdrawal = yield* payout.requestWithdrawal(TEST_USER, Payout.MIN_WITHDRAWAL_CREDITS, "stripe")
    // withdrawal is still "pending" — complete should fail.
    const err = yield* failureOf(payout.completeWithdrawal(withdrawal.id, "ref_123"))
    expect(err).toBeInstanceOf(Payout.InvalidWithdrawalStateError)

    // Move to processing, then complete works.
    yield* payout.processWithdrawal(withdrawal.id)
    const completed = yield* payout.completeWithdrawal(withdrawal.id, "ref_123")
    expect(completed.status).toBe("completed")
    expect(completed.payoutReference).toBe("ref_123")
  }))

  eff.effect("getOrCreatePayoutAccount auto-provisions a mock account (VAL-PAYOUT-010)", Effect.gen(function* () {
    const payout = yield* Payout.PayoutService
    const account = yield* payout.getOrCreatePayoutAccount(TEST_USER)
    expect(account.userId).toBe(TEST_USER)
    expect(account.provider).toBe("manual")
    expect(account.status).toBe("active")

    // Idempotent: second call returns the same account.
    const again = yield* payout.getOrCreatePayoutAccount(TEST_USER)
    expect(again.id).toBe(account.id)
  }))
})
