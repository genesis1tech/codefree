# Attribution

## Upstream Project

- **Project**: [OpenCode](https://github.com/anomalyco/opencode)
- **Version forked**: v1.17.8
- **Fork date**: June 2026
- **License**: MIT

## Summary of Changes

CodeFree is an ad-sponsored fork of OpenCode. The following changes have been made:

- **Wallet system**: Added wallet and wallet_transaction tables for tracking ad-earned credits and API usage debits.
- **Ad system**: Added ad_impression and ad_click_event tables, an ad service, and ad type definitions for in-terminal advertising during agent thinking.
- **CodeFree config**: Added `codefree:` configuration block (opt-in ad settings) to the user config schema.
- **Branding**: Replaced OpenCode branding with CodeFree branding.
- All upstream code, architecture, and structure is preserved as-is per MIT license requirements.
