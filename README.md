# CodeFree

**Code free. Literally.**

CodeFree is an ad-sponsored AI coding agent. Earn credits by allowing non-intrusive ads during agent thinking time — credits offset your API costs so you can code for free.

## What It Is

CodeFree is a fork of [OpenCode](https://github.com/anomalyco/opencode), a terminal-based AI coding agent. CodeFree adds an ad-supported credit layer: while the agent thinks, you see brief sponsored messages. Each view earns you credits that reduce your effective API spend.

## How It Works

1. **Enable ads in your config** — flip `codefree.enabled` to `true` in `opencode.json`
2. **Use CodeFree as your agent** — interact with it normally; ads appear during thinking/tool gaps
3. **Earn credits** — each ad view earns 4 credits, each click earns 100 credits; 1 credit = $0.01

## BYOK (Bring Your Own Key)

CodeFree never touches your provider billing. You bring your own Anthropic (or other) API key. Credits earned from ads are tracked in a local wallet and applied against your measured API usage. Your key stays yours.

## Quick Start

CodeFree runs from source today using [Bun](https://bun.sh). A published `codefree`
package is planned but not yet available.

```bash
# From the repo root
bun install

# Bring your own provider key (OpenAI is the validated provider)
echo "OPENAI_API_KEY=sk-..." > .env

# Enable ads (opt-in) by adding to opencode.json:
# { "codefree": { "enabled": true } }

# Launch the TUI from source
bun run dev --model openai/gpt-4o
```

The eventual published install (not yet available) will be:

```bash
npm install -g codefree
```

See [Development](#development-run-from-source) and [Environment](#environment) for details.

## Development (run from source)

**Prerequisites**: [Bun](https://bun.sh) (the repo pins `bun@1.3.14`).

Install all workspace dependencies from the repo root:

```bash
bun install
```

This is a Bun monorepo. The CodeFree-relevant packages are:

- `packages/core` — ad engine (`ad/types`, `ad/service`, `ad/injector`), the local wallet module/service, and config-merge + `applyUsage` cost accounting.
- `packages/opencode` — CLI/TUI host and session integration: the CodeFree service, `maybeShowAd` (config read, local user id, ad/credit events), `applyUsage` cost-offset, processor wiring, and wallet boot hydration.
- `packages/tui` — terminal UI surfaces: the `WalletIndicator` footer, the `/ads` dialog, ad preferences, and the wallet context store.
- `packages/server` — minimal stub package required so the TUI worker thread boots.

Launch the TUI from source with the root `dev` script (which runs the `packages/opencode/src/index.ts` entrypoint via `bun run --cwd packages/opencode --conditions=browser src/index.ts`):

```bash
bun run dev

# or pass a model directly
bun run dev --model openai/gpt-4o
```

## Environment

For end-to-end use you bring your own provider key (BYOK) — it stays local. The validated configuration in this project is **OpenAI**:

```bash
# repo-root .env
OPENAI_API_KEY=sk-...
```

```bash
bun run dev --model openai/gpt-4o
```

Other providers also work via opencode's normal provider configuration.

To actually see ads and earn credits, opt in via `opencode.json` and run a tool-using prompt so that a tool gap occurs:

```json
{ "codefree": { "enabled": true, "min_interval_ms": 30000, "max_ads_per_hour": 25 } }
```

See [Configuration](#configuration) for the full list of fields. The local credit wallet persists under the opencode data dir, keyed by a stable local user id, so balances survive restarts with no login required.

## Testing

Run the CodeFree test suites with Bun:

```bash
# Core unit tests (ad engine, wallet, config)
cd packages/core && bun test test/ad.test.ts test/wallet.test.ts test/codefree-config.test.ts

# Session integration tests
cd packages/opencode && bun test test/codefree.test.ts

# Optional: TUI wallet store unit tests
cd packages/tui && bun test test/wallet.test.ts
```

Typecheck per package:

```bash
cd packages/core && bunx tsc --noEmit
cd packages/opencode && bunx tsc --noEmit
cd packages/tui && bunx tsc --noEmit
```

## Configuration

Add a `codefree:` block to your `opencode.json`:

```json
{
  "codefree": {
    "enabled": false,
    "min_interval_ms": 30000,
    "max_ads_per_hour": 25,
    "categories": ["devtool", "saas", "recruiting", "education", "affiliate"],
    "show_wallet_indicator": true,
    "auto_dismiss_ms": 8000
  }
}
```

**Fields**:

- `enabled` — opt in to ad-supported credit earning (default: `false`)
- `min_interval_ms` — minimum time between ads (default: `30000`)
- `max_ads_per_hour` — hourly ad cap (default: `25`)
- `categories` — ad categories to show (default: all five categories)
- `show_wallet_indicator` — show credit balance in UI (default: `true`)
- `auto_dismiss_ms` — auto-dismiss delay in ms (default: `8000`)

## Credit Economics

- **Ad view**: 4 credits
- **Ad click**: 100 credits
- **1 credit** = $0.01 USD equivalent

Credits are tracked in a local wallet and debited against measured API usage.

## Privacy

In Phase 0, all ads are local-only. There is no third-party tracking, no telemetry sent to advertisers, and no external network calls for ad delivery. Sponsored content is bundled or configured locally. See `ATTRIBUTION.md` for full details.

## Roadmap

- **Phase 0 (current)**: MVP local ads — earn credits from placeholder/promo ads, local wallet tracking
- **Phase 1**: Ad server integration — real advertisers, richer targeting, improved credit payout rates
- **Phase 2**: Cash payouts — convert earned credits to cash withdrawals

## Acknowledgments

CodeFree is a fork of [OpenCode](https://github.com/anomalyco/opencode) by the Anomaly team. OpenCode is licensed under the MIT License. See [LICENSE](./LICENSE) for full terms and [ATTRIBUTION.md](./ATTRIBUTION.md) for fork details.

## License

MIT License. See [LICENSE](./LICENSE).
