import { desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { CREDIT_USD_VALUE } from "./config"
import { WalletTable, WalletTransactionTable } from "./sql"
import { NonNegativeInt, withStatics } from "../schema"
import { Identifier } from "../util/identifier"

// --- Branded IDs ---

export const ID = Schema.String.pipe(
  Schema.brand("Wallet.ID"),
  withStatics((schema) => ({ create: () => schema.make("wlt_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const TransactionID = Schema.String.pipe(
  Schema.brand("Wallet.TransactionID"),
  withStatics((schema) => ({ create: () => schema.make("wtx_" + Identifier.ascending()) })),
)
export type TransactionID = typeof TransactionID.Type

// --- Domain types ---

export const TransactionType = Schema.Literals(["ad_view", "affiliate_click", "api_usage", "bonus", "adjustment"])
export type TransactionType = typeof TransactionType.Type

export class WalletInfo extends Schema.Class<WalletInfo>("Wallet.Info")({
  id: ID,
  userId: Schema.String,
  balanceCredits: NonNegativeInt,
  lifetimeEarnedCredits: NonNegativeInt,
  lifetimeSpentCredits: NonNegativeInt,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
}) {}

export class TransactionInfo extends Schema.Class<TransactionInfo>("Wallet.TransactionInfo")({
  id: TransactionID,
  walletId: ID,
  type: TransactionType,
  amountCredits: Schema.Int,
  description: Schema.String,
  referenceId: Schema.optional(Schema.String),
  createdAt: NonNegativeInt,
}) {}

// --- Errors ---

export class InsufficientBalanceError extends Schema.TaggedErrorClass<InsufficientBalanceError>()(
  "InsufficientBalanceError",
  {
    required: Schema.Int,
    available: Schema.Int,
  },
) {
  override get message(): string {
    return `Insufficient balance: need ${this.required} credits but only ${this.available} available`
  }
}

export class WalletNotFoundError extends Schema.TaggedErrorClass<WalletNotFoundError>()("WalletNotFoundError", {
  userId: Schema.String,
}) {
  override get message(): string {
    return `Wallet not found for user: ${this.userId}`
  }
}

// --- Credit conversion helpers ---

export function creditsToUsd(credits: number): number {
  return credits * CREDIT_USD_VALUE
}

export function usdToCredits(usd: number): number {
  return Math.round(usd / CREDIT_USD_VALUE)
}

export function formatCredits(credits: number): string {
  return `${credits.toLocaleString()} credits ($${creditsToUsd(credits).toFixed(2)})`
}

// --- Row mappers ---

function rowToWalletInfo(row: typeof WalletTable.$inferSelect): WalletInfo {
  return new WalletInfo({
    id: ID.make(row.id),
    userId: row.user_id,
    balanceCredits: row.balance_credits,
    lifetimeEarnedCredits: row.lifetime_earned_credits,
    lifetimeSpentCredits: row.lifetime_spent_credits,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  })
}

function rowToTransactionInfo(row: typeof WalletTransactionTable.$inferSelect): TransactionInfo {
  return new TransactionInfo({
    id: TransactionID.make(row.id),
    walletId: ID.make(row.wallet_id),
    type: Schema.decodeUnknownSync(TransactionType)(row.type),
    amountCredits: row.amount_credits,
    description: row.description,
    referenceId: row.reference_id ?? undefined,
    createdAt: row.time_created,
  })
}

// --- Service ---

export interface Interface {
  readonly getOrCreateWallet: (userId: string) => Effect.Effect<WalletInfo, WalletNotFoundError>
  readonly getBalance: (userId: string) => Effect.Effect<WalletInfo, WalletNotFoundError>
  readonly creditWallet: (
    userId: string,
    amount: number,
    type: TransactionType,
    description: string,
    referenceId?: string,
  ) => Effect.Effect<WalletInfo, WalletNotFoundError>
  readonly debitWallet: (
    userId: string,
    amount: number,
    description: string,
    referenceId?: string,
  ) => Effect.Effect<WalletInfo, WalletNotFoundError | InsufficientBalanceError>
  readonly getTransactionHistory: (
    userId: string,
    limit?: number,
    offset?: number,
  ) => Effect.Effect<TransactionInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Wallet") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const findWalletByUser = (userId: string) =>
      db.select().from(WalletTable).where(eq(WalletTable.user_id, userId)).get().pipe(Effect.orDie)

    const createWallet = (userId: string) =>
      Effect.gen(function* () {
        const id = ID.create()
        yield* db
          .insert(WalletTable)
          .values({
            id,
            user_id: userId,
            balance_credits: 0,
            lifetime_earned_credits: 0,
            lifetime_spent_credits: 0,
          })
          .run()
          .pipe(Effect.orDie)
        const row = yield* findWalletByUser(userId)
        if (!row) return yield* new WalletNotFoundError({ userId })
        return rowToWalletInfo(row)
      })

    return Service.of({
      getOrCreateWallet: Effect.fn("Wallet.getOrCreateWallet")(function* (userId) {
        const existing = yield* findWalletByUser(userId)
        if (existing) return rowToWalletInfo(existing)
        return yield* createWallet(userId)
      }),

      getBalance: Effect.fn("Wallet.getBalance")(function* (userId) {
        const row = yield* findWalletByUser(userId)
        if (!row) return yield* new WalletNotFoundError({ userId })
        return rowToWalletInfo(row)
      }),

      creditWallet: Effect.fn("Wallet.creditWallet")(function* (userId, amount, type, description, referenceId) {
        const walletId = ID.create()
        const transactionId = TransactionID.create()
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Upsert wallet then credit
              const existing = yield* tx.select().from(WalletTable).where(eq(WalletTable.user_id, userId)).get()
              if (!existing) {
                yield* tx
                  .insert(WalletTable)
                  .values({
                    id: walletId,
                    user_id: userId,
                    balance_credits: amount,
                    lifetime_earned_credits: amount,
                    lifetime_spent_credits: 0,
                  })
                  .run()
              } else {
                yield* tx
                  .update(WalletTable)
                  .set({
                    balance_credits: sql`${WalletTable.balance_credits} + ${amount}`,
                    lifetime_earned_credits: sql`${WalletTable.lifetime_earned_credits} + ${amount}`,
                  })
                  .where(eq(WalletTable.id, existing.id))
                  .run()
              }
              yield* tx
                .insert(WalletTransactionTable)
                .values({
                  id: transactionId,
                  wallet_id: existing ? existing.id : walletId,
                  type,
                  amount_credits: amount,
                  description,
                  reference_id: referenceId ?? null,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        const row = yield* findWalletByUser(userId)
        if (!row) return yield* new WalletNotFoundError({ userId })
        return rowToWalletInfo(row)
      }),

      debitWallet: Effect.fn("Wallet.debitWallet")(function* (userId, amount, description, referenceId) {
        // Pre-check existence and balance outside the transaction so the tagged errors
        // (WalletNotFoundError / InsufficientBalanceError) surface as typed failures
        // catchable by callers, instead of being converted to defects by the transaction's
        // Effect.orDie. The wallet balance is left untouched on rejection.
        const existing = yield* findWalletByUser(userId)
        if (!existing) return yield* new WalletNotFoundError({ userId })
        if (existing.balance_credits < amount) {
          return yield* new InsufficientBalanceError({ required: amount, available: existing.balance_credits })
        }
        const transactionId = TransactionID.create()
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(WalletTable)
                .set({
                  balance_credits: sql`${WalletTable.balance_credits} - ${amount}`,
                  lifetime_spent_credits: sql`${WalletTable.lifetime_spent_credits} + ${amount}`,
                })
                .where(eq(WalletTable.id, existing.id))
                .run()
              yield* tx
                .insert(WalletTransactionTable)
                .values({
                  id: transactionId,
                  wallet_id: existing.id,
                  type: "api_usage",
                  amount_credits: -amount,
                  description,
                  reference_id: referenceId ?? null,
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        const row = yield* findWalletByUser(userId)
        if (!row) return yield* new WalletNotFoundError({ userId })
        return rowToWalletInfo(row)
      }),

      getTransactionHistory: Effect.fn("Wallet.getTransactionHistory")(function* (userId, limit = 50, offset = 0) {
        const wallet = yield* findWalletByUser(userId)
        if (!wallet) return []
        return (yield* db
          .select()
          .from(WalletTransactionTable)
          .where(eq(WalletTransactionTable.wallet_id, wallet.id))
          .orderBy(desc(WalletTransactionTable.time_created))
          .limit(limit)
          .offset(offset)
          .all()
          .pipe(Effect.orDie)).map(rowToTransactionInfo)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
