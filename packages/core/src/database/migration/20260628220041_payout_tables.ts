import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260628220041_payout_tables",
  up(tx) {
    return Effect.gen(function* () {
      // Phase 2 payout tables. wallet + wallet_transaction + ad tables were created by the
      // 20260620120000_wallet_ad_tables migration; this migration adds only the new tables.
      yield* tx.run(`
        CREATE TABLE \`payout_account\` (
          \`id\` text PRIMARY KEY,
          \`user_id\` text NOT NULL,
          \`provider\` text NOT NULL,
          \`provider_account_id\` text,
          \`status\` text NOT NULL,
          \`details\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`withdrawal_request\` (
          \`id\` text PRIMARY KEY,
          \`wallet_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`amount_credits\` integer NOT NULL,
          \`amount_usd\` real NOT NULL,
          \`status\` text NOT NULL,
          \`payout_method\` text NOT NULL,
          \`payout_reference\` text,
          \`failure_reason\` text,
          \`requested_at\` integer NOT NULL,
          \`processed_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_withdrawal_request_wallet_id_wallet_id_fk\` FOREIGN KEY (\`wallet_id\`) REFERENCES \`wallet\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`payout_account_user_id_idx\` ON \`payout_account\` (\`user_id\`);`)
      yield* tx.run(`CREATE INDEX \`payout_account_provider_idx\` ON \`payout_account\` (\`provider\`);`)
      yield* tx.run(`CREATE INDEX \`withdrawal_request_wallet_id_idx\` ON \`withdrawal_request\` (\`wallet_id\`);`)
      yield* tx.run(`CREATE INDEX \`withdrawal_request_user_id_idx\` ON \`withdrawal_request\` (\`user_id\`);`)
      yield* tx.run(`CREATE INDEX \`withdrawal_request_status_idx\` ON \`withdrawal_request\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
