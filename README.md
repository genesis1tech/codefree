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

```bash
# Install
npm install -g codefree

# Configure your API key
codefree config set providers.anthropic.api.key sk-ant-...

# Enable ads (opt-in)
# Add to opencode.json:
# { "codefree": { "enabled": true } }

# Start
codefree
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
