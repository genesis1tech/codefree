# LEDGER

One entry per mission. Draft location, point-by-point self-grade against the 8
gates in SUCCESS.md, and every patch the refinement loop made.

---

## 01-ad-economy-close-the-loop — 2026-07-08

**Draft:** wargames/01-ad-economy-close-the-loop.md
**Mission:** Close the CodeFree ad economy loop — dwell-verified view credits + daily cap, in-TUI ad panel + click→credit path, local ad server, local OpenAI-compatible gateway with credit→token redemption through the withdrawal state machine.
**Executor:** GLM-5.2 (fallback Sonnet 5)

**Self-grade (SUCCESS.md):**
1. Expected observation per move — PASS — all 25 moves (R1–R3, 1–22) name concrete outputs (`0 fail`, exact grep hits, exact curl bodies, exact JSON statuses).
2. Failure + cause + counter-move per move — PASS — every move carries a named most-likely failure with the cause it signals and a concrete counter (e.g. Move 2 timestamp-format trap → print-and-match counter; Move 17 SSE tee corruption → return the raw branch, scan the tee).
3. Every fork has a trigger — PASS — Move 1 (R-C generator vs hand-maintained), Move 3 (tests asserting instant credit), Move 6 (R-A session-scoped service → hoist logic to core), Move 7 (error stack never mentions codefree → stash check → raw-fetch fallback), Move 10 (missing `slot_min_ms` → coded fallback).
4. RECON NEEDED on unsettled assumptions — PASS — R-A…R-E each carry the exact grep/read that settles them, resolved in Moves R2–R3 before any write.
5. Abort conditions exist — PASS — six: red baseline (>5 failures), upstream-runtime edits beyond named seams, real credentials/payments/deploys, double-failed SDK regen + fetch fallback, unregisterable migration, >2500-line diff drift.
6. Verification spelled out — PASS — V1–V7 with exact commands and exact pass output (`0 fail`, `OK <n>`, `cfg_`, `401`/`402`), plus per-phase commits and PR step targeting `phase-one-ads`.
7. Survived a red-team pass — PASS — withstood: unlucky-path attack on SDK regen (three-layer recovery already in plan). Landed + patched: (a) literal-executor stall on Move 6 service reachability → fork now names the exact resolution (hoist `completeImpression` into core, export the user-id helper); (b) runaway double-credit on Move 19 deposit timeout → UNIQUE `deposits.reference` idempotency + no-retry rule + flagged residual edge; (c) silent assumption on event-shape compatibility → add-only event fields rule + unconditional duration fallback.
8. Executable blind by a mid-tier model — PASS — design decisions section removes all judgment calls (ports, package names, price table, status vocabulary, escrow semantics); every file/line/command is named; the AdServerResponse contract points at the schema file as source of truth rather than prose.

**Patches this run:**
- Fixed Move 10's mislabeled reference to Verification run V5 — the interactive TUI check is now explicitly optional and outside V1–V7 (literal-executor stall risk).
- Rewrote V4 to remove a false dependency between host tests and the running adserver's database; V4 now only proves adserver schema-on-disk, with loop correctness owned by VAL-CF-030/032 in V2.
