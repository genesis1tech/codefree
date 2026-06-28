import { desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Identifier } from "../util/identifier"
import { NonNegativeInt, withStatics } from "../schema"
import { creditsToUsd, ID as WalletID, TransactionID, WalletNotFoundError, InsufficientBalanceError } from "./index"
import {
  WalletTable,
  WalletTransactionTable,
  WithdrawalRequestTable,
  WithdrawalStatusValues,
  PayoutAccountTable,
} from "./sql"

// --- Branded IDs ---

export const WithdrawalID = Schema.String.pipe(
  Schema.brand("Wallet.WithdrawalID"),
  withStatics((schema) => ({ create: () => schema.make("wdl_" + Identifier.ascending()) })),
)
export type WithdrawalID = typeof WithdrawalID.Type

export const PayoutAccountID = Schema.String.pipe(
  Schema.brand("Wallet.PayoutAccountID"),
  withStatics((schema) => ({ create: () => schema.make("pac_" + Identifier.ascending()) })),
)
export type PayoutAccountID = typeof PayoutAccountID.Type

// --- Domain types ---

export const WithdrawalStatus = Schema.Literals(WithdrawalStatusValues)
export type WithdrawalStatus = typeof WithdrawalStatus.Type

export const PayoutMethod = Schema.Literals(["manual", "stripe", "paypal"])
export type PayoutMethod = typeof PayoutMethod.Type

export class WithdrawalRequest extends Schema.Class<WithdrawalRequest>("Wallet.WithdrawalRequest")({
  id: WithdrawalID,
  walletId: WalletID,
  userId: Schema.String,
  amountCredits: NonNegativeInt,
  amountUsd: Schema.Number,
  status: WithdrawalStatus,
  payoutMethod: PayoutMethod,
  payoutReference: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  requestedAt: NonNegativeInt,
  processedAt: Schema.optional(NonNegativeInt),
}) {}

export class PayoutAccount extends Schema.Class<PayoutAccount>("Wallet.PayoutAccount")({
  id: PayoutAccountID,
  userId: Schema.String,
  provider: PayoutMethod,
  providerAccountId: Schema.optional(Schema.String),
  status: Schema.Literals(["active", "pending", "disabled"]),
  details: Schema.optional(Schema.String),
}) {}

// --- Errors ---

export class BelowMinimumWithdrawalError extends Schema.TaggedErrorClass<BelowMinimumWithdrawalError>()(
  "BelowMinimumWithdrawalError",
  { requested: Schema.Int, minimum: Schema.Int },
) {
  override get message(): string {
    return `Withdrawal below minimum: requested ${this.requested} credits but minimum is ${this.minimum}`
  }
}

export class WithdrawalNotFoundError extends Schema.TaggedErrorClass<WithdrawalNotFoundError>()(
  "WithdrawalNotFoundError",
  { withdrawalId: Schema.String },
) {
  override get message(): string {
    return `Withdrawal not found: ${this.withdrawalId}`
  }
}

export class InvalidWithdrawalStateError extends Schema.TaggedErrorClass<InvalidWithdrawalStateError>()(
  "InvalidWithdrawalStateError",
  { withdrawalId: Schema.String, currentStatus: Schema.String, attemptedAction: Schema.String },
) {
  override get message(): string {
    return `Cannot ${this.attemptedAction} withdrawal ${this.withdrawalId}: current status is ${this.currentStatus}`
  }
}

// --- Constants ---

// Minimum withdrawable credits. At $0.01/credit this is $10.00 — high enough to make payouts
// economically viable against provider transaction fees.
export const MIN_WITHDRAWAL_CREDITS = 1000

// --- Row mappers ---

function rowToWithdrawalRequest(row: typeof WithdrawalRequestTable.$inferSelect): WithdrawalRequest {
  return new WithdrawalRequest({
    id: WithdrawalID.make(row.id),
    walletId: WalletID.make(row.wallet_id),
    userId: row.user_id,
    amountCredits: row.amount_credits,
    amountUsd: row.amount_usd,
    status: Schema.decodeUnknownSync(WithdrawalStatus)(row.status),
    payoutMethod: Schema.decodeUnknownSync(PayoutMethod)(row.payout_method),
    payoutReference: row.payout_reference ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    requestedAt: row.requested_at,
    processedAt: row.processed_at ?? undefined,
  })
}

// --- Service ---

export interface PayoutInterface {
  readonly requestWithdrawal: (
    userId: string,
    amountCredits: number,
    payoutMethod?: PayoutMethod,
  ) => Effect.Effect<
    WithdrawalRequest,
    WalletNotFoundError | InsufficientBalanceError | BelowMinimumWithdrawalError | WithdrawalNotFoundError
  >
  readonly getWithdrawal: (withdrawalId: string) => Effect.Effect<WithdrawalRequest, WithdrawalNotFoundError>
  readonly getWithdrawals: (userId: string) => Effect.Effect<ReadonlyArray<WithdrawalRequest>>
  readonly cancelWithdrawal: (
    withdrawalId: string,
    userId: string,
  ) => Effect.Effect<WithdrawalRequest, WithdrawalNotFoundError | InvalidWithdrawalStateError>
  readonly processWithdrawal: (withdrawalId: string) => Effect.Effect<WithdrawalRequest, WithdrawalNotFoundError | InvalidWithdrawalStateError>
  readonly completeWithdrawal: (
    withdrawalId: string,
    payoutReference: string,
  ) => Effect.Effect<WithdrawalRequest, WithdrawalNotFoundError | InvalidWithdrawalStateError>
  readonly failWithdrawal: (
    withdrawalId: string,
    reason: string,
  ) => Effect.Effect<WithdrawalRequest, WithdrawalNotFoundError | InvalidWithdrawalStateError>
  readonly getOrCreatePayoutAccount: (userId: string, provider?: PayoutMethod) => Effect.Effect<PayoutAccount>
}

export class PayoutService extends Context.Service<PayoutService, PayoutInterface>()("@opencode/v2/Wallet/Payout") {}

export const layer = Layer.effect(
  PayoutService,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const findWalletByUser = (userId: string) =>
      db.select().from(WalletTable).where(eq(WalletTable.user_id, userId)).get().pipe(Effect.orDie)

    const findWithdrawal = (withdrawalId: string) =>
      db.select().from(WithdrawalRequestTable).where(eq(WithdrawalRequestTable.id, withdrawalId)).get().pipe(Effect.orDie)

    return PayoutService.of({
      requestWithdrawal: Effect.fn("Payout.requestWithdrawal")(function* (
        userId,
        amountCredits,
        payoutMethod = "manual" as PayoutMethod,
      ) {
        // Validate the minimum threshold before touching the wallet.
        if (amountCredits < MIN_WITHDRAWAL_CREDITS) {
          return yield* new BelowMinimumWithdrawalError({ requested: amountCredits, minimum: MIN_WITHDRAWAL_CREDITS })
        }

        // Pre-check wallet existence and balance so typed errors surface cleanly.
        const wallet = yield* findWalletByUser(userId)
        if (!wallet) return yield* new WalletNotFoundError({ userId })
        if (wallet.balance_credits < amountCredits) {
          return yield* new InsufficientBalanceError({ required: amountCredits, available: wallet.balance_credits })
        }

        const withdrawalId = WithdrawalID.create()
        const now = Date.now()

        // Atomic escrow: debit the balance + record the withdrawal transaction + create the
        // withdrawal_request row in one DB transaction. If any step fails, nothing is committed.
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(WalletTable)
                .set({ balance_credits: sql`${WalletTable.balance_credits} - ${amountCredits}` })
                .where(eq(WalletTable.id, wallet.id))
                .run()
              yield* tx
                .insert(WalletTransactionTable)
                .values({
                  id: TransactionID.create(),
                  wallet_id: wallet.id,
                  type: "withdrawal",
                  amount_credits: -amountCredits,
                  description: `Withdrawal request: ${amountCredits} credits ($${creditsToUsd(amountCredits).toFixed(2)})`,
                  reference_id: withdrawalId,
                })
                .run()
              yield* tx
                .insert(WithdrawalRequestTable)
                .values({
                  id: withdrawalId,
                  wallet_id: wallet.id,
                  user_id: userId,
                  amount_credits: amountCredits,
                  amount_usd: creditsToUsd(amountCredits),
                  status: "pending",
                  payout_method: payoutMethod,
                  requested_at: now,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)

        // For the mock provider, immediately complete the withdrawal. A real provider would leave
        // it in "pending" and wait for an async webhook callback before transitioning to
        // "processing" then "completed".
        if (payoutMethod === "manual") {
          yield* db
            .update(WithdrawalRequestTable)
            .set({ status: "processing", processed_at: now })
            .where(eq(WithdrawalRequestTable.id, withdrawalId))
            .run()
            .pipe(Effect.orDie)
          yield* db
            .update(WithdrawalRequestTable)
            .set({ status: "completed", payout_reference: `manual_${withdrawalId}` })
            .where(eq(WithdrawalRequestTable.id, withdrawalId))
            .run()
            .pipe(Effect.orDie)
        }

        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      getWithdrawal: Effect.fn("Payout.getWithdrawal")(function* (withdrawalId) {
        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      getWithdrawals: Effect.fn("Payout.getWithdrawals")(function* (userId) {
        return (yield* db
          .select()
          .from(WithdrawalRequestTable)
          .where(eq(WithdrawalRequestTable.user_id, userId))
          .orderBy(desc(WithdrawalRequestTable.time_created))
          .all()
          .pipe(Effect.orDie)).map(rowToWithdrawalRequest)
      }),

      cancelWithdrawal: Effect.fn("Payout.cancelWithdrawal")(function* (withdrawalId, userId) {
        const existing = yield* findWithdrawal(withdrawalId)
        if (!existing) return yield* new WithdrawalNotFoundError({ withdrawalId })
        // Only pending withdrawals can be cancelled by the user.
        if (existing.status !== "pending") {
          return yield* new InvalidWithdrawalStateError({
            withdrawalId,
            currentStatus: existing.status,
            attemptedAction: "cancel",
          })
        }

        // Refund the escrowed credits atomically: credit the balance back + record a refund
        // transaction + mark the withdrawal cancelled.
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(WalletTable)
                .set({ balance_credits: sql`${WalletTable.balance_credits} + ${existing.amount_credits}` })
                .where(eq(WalletTable.id, existing.wallet_id))
                .run()
              yield* tx
                .insert(WalletTransactionTable)
                .values({
                  id: TransactionID.create(),
                  wallet_id: existing.wallet_id,
                  type: "withdrawal_refund",
                  amount_credits: existing.amount_credits,
                  description: `Withdrawal cancelled: refunded ${existing.amount_credits} credits`,
                  reference_id: withdrawalId,
                })
                .run()
              yield* tx
                .update(WithdrawalRequestTable)
                .set({ status: "cancelled", processed_at: Date.now() })
                .where(eq(WithdrawalRequestTable.id, withdrawalId))
                .run()
            }),
          )
          .pipe(Effect.orDie)

        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      processWithdrawal: Effect.fn("Payout.processWithdrawal")(function* (withdrawalId) {
        const existing = yield* findWithdrawal(withdrawalId)
        if (!existing) return yield* new WithdrawalNotFoundError({ withdrawalId })
        if (existing.status !== "pending") {
          return yield* new InvalidWithdrawalStateError({
            withdrawalId,
            currentStatus: existing.status,
            attemptedAction: "process",
          })
        }
        yield* db
          .update(WithdrawalRequestTable)
          .set({ status: "processing", processed_at: Date.now() })
          .where(eq(WithdrawalRequestTable.id, withdrawalId))
          .run()
          .pipe(Effect.orDie)
        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      completeWithdrawal: Effect.fn("Payout.completeWithdrawal")(function* (withdrawalId, payoutReference) {
        const existing = yield* findWithdrawal(withdrawalId)
        if (!existing) return yield* new WithdrawalNotFoundError({ withdrawalId })
        if (existing.status !== "processing") {
          return yield* new InvalidWithdrawalStateError({
            withdrawalId,
            currentStatus: existing.status,
            attemptedAction: "complete",
          })
        }
        yield* db
          .update(WithdrawalRequestTable)
          .set({ status: "completed", payout_reference: payoutReference })
          .where(eq(WithdrawalRequestTable.id, withdrawalId))
          .run()
          .pipe(Effect.orDie)
        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      failWithdrawal: Effect.fn("Payout.failWithdrawal")(function* (withdrawalId, reason) {
        const existing = yield* findWithdrawal(withdrawalId)
        if (!existing) return yield* new WithdrawalNotFoundError({ withdrawalId })
        // Only pending or processing withdrawals can fail.
        if (existing.status !== "pending" && existing.status !== "processing") {
          return yield* new InvalidWithdrawalStateError({
            withdrawalId,
            currentStatus: existing.status,
            attemptedAction: "fail",
          })
        }

        // Refund the escrowed credits atomically (same as cancel).
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(WalletTable)
                .set({ balance_credits: sql`${WalletTable.balance_credits} + ${existing.amount_credits}` })
                .where(eq(WalletTable.id, existing.wallet_id))
                .run()
              yield* tx
                .insert(WalletTransactionTable)
                .values({
                  id: TransactionID.create(),
                  wallet_id: existing.wallet_id,
                  type: "withdrawal_refund",
                  amount_credits: existing.amount_credits,
                  description: `Withdrawal failed (${reason}): refunded ${existing.amount_credits} credits`,
                  reference_id: withdrawalId,
                })
                .run()
              yield* tx
                .update(WithdrawalRequestTable)
                .set({ status: "failed", failure_reason: reason, processed_at: Date.now() })
                .where(eq(WithdrawalRequestTable.id, withdrawalId))
                .run()
            }),
          )
          .pipe(Effect.orDie)

        const row = yield* findWithdrawal(withdrawalId)
        if (!row) return yield* new WithdrawalNotFoundError({ withdrawalId })
        return rowToWithdrawalRequest(row)
      }),

      getOrCreatePayoutAccount: Effect.fn("Payout.getOrCreatePayoutAccount")(function* (userId, provider = "manual" as PayoutMethod) {
        const existing = yield* db
          .select()
          .from(PayoutAccountTable)
          .where(eq(PayoutAccountTable.user_id, userId))
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          return new PayoutAccount({
            id: PayoutAccountID.make(existing.id),
            userId: existing.user_id,
            provider: Schema.decodeUnknownSync(PayoutMethod)(existing.provider),
            providerAccountId: existing.provider_account_id ?? undefined,
            status: existing.status as "active" | "pending" | "disabled",
            details: existing.details ?? undefined,
          })
        }
        // Auto-provision a mock payout account. A real provider would redirect to an onboarding
        // flow (Stripe Connect hosted onboarding, PayPal account linking) before the account is
        // "active". For the mock provider, the account is immediately active with no external id.
        const accountId = PayoutAccountID.create()
        yield* db
          .insert(PayoutAccountTable)
          .values({
            id: accountId,
            user_id: userId,
            provider,
            status: "active",
          })
          .run()
          .pipe(Effect.orDie)
        return new PayoutAccount({
          id: accountId,
          userId,
          provider,
          status: "active",
        })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
