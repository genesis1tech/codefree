import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260620120000_wallet_ad_tables",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`wallet\` (
          \`id\` text PRIMARY KEY,
          \`user_id\` text NOT NULL,
          \`balance_credits\` integer NOT NULL DEFAULT 0,
          \`lifetime_earned_credits\` integer NOT NULL DEFAULT 0,
          \`lifetime_spent_credits\` integer NOT NULL DEFAULT 0,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`wallet_user_id_idx\` ON \`wallet\` (\`user_id\`);`)
      yield* tx.run(`
        CREATE TABLE \`wallet_transaction\` (
          \`id\` text PRIMARY KEY,
          \`wallet_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`amount_credits\` integer NOT NULL,
          \`description\` text NOT NULL,
          \`reference_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_wallet_transaction_wallet_id_wallet_id_fk\` FOREIGN KEY (\`wallet_id\`) REFERENCES \`wallet\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`wallet_transaction_wallet_id_idx\` ON \`wallet_transaction\` (\`wallet_id\`);`)
      yield* tx.run(`CREATE INDEX \`wallet_transaction_type_idx\` ON \`wallet_transaction\` (\`type\`);`)
      yield* tx.run(`CREATE INDEX \`wallet_transaction_time_created_idx\` ON \`wallet_transaction\` (\`time_created\`);`)
      yield* tx.run(`
        CREATE TABLE \`ad_impression\` (
          \`id\` text PRIMARY KEY,
          \`ad_id\` text NOT NULL,
          \`slot_type\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`shown_at\` integer NOT NULL,
          \`duration_ms\` integer NOT NULL,
          \`clicked\` integer NOT NULL DEFAULT 0,
          \`click_url\` text
        );
      `)
      yield* tx.run(`CREATE INDEX \`ad_impression_session_id_idx\` ON \`ad_impression\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`ad_impression_user_id_idx\` ON \`ad_impression\` (\`user_id\`);`)
      yield* tx.run(`CREATE INDEX \`ad_impression_shown_at_idx\` ON \`ad_impression\` (\`shown_at\`);`)
      yield* tx.run(`
        CREATE TABLE \`ad_click_event\` (
          \`id\` text PRIMARY KEY,
          \`impression_id\` text NOT NULL,
          \`ad_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`click_url\` text NOT NULL,
          \`clicked_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`ad_click_event_session_id_idx\` ON \`ad_click_event\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`ad_click_event_user_id_idx\` ON \`ad_click_event\` (\`user_id\`);`)
      yield* tx.run(`CREATE INDEX \`ad_click_event_clicked_at_idx\` ON \`ad_click_event\` (\`clicked_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
