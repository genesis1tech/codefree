import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260708173520_ad_trust",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`codefree_preference\` (
          \`user_id\` text PRIMARY KEY,
          \`enabled\` integer DEFAULT 0 NOT NULL,
          \`categories\` text DEFAULT '[]' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`ad_impression\` ADD \`credited\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`ad_impression\` ADD \`slot_min_ms\` integer DEFAULT 8000 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
