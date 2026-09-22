# scratch-cards-program

On-chain program for **Scratch Cards** (`../scratch-cards`), in the exact shape of
`dark-galaxy-solana`: a native (non-Anchor) program on Solarium's `#[program]` dispatch
(`src/lib.rs` is the whole wire interface), `ephemeral-rollups-sdk` delegation, bytemuck state,
and hand-rolled CPIs for SPL Token and the MagicBlock VRF (no extra dependency trees).

Program id: `GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC` (`keys/program-keypair.json`) —
the same id on both clusters, live on mainnet-beta and devnet. Scripts pick the cluster
with `--mainnet`, which also picks the key that signs and pays (`scripts/net.mjs`).

## Money

The game holds no token accounts of its own. Every balance — the player's, the house's, the
jackpot pot — is a **vault ledger** (`VAULTrDSU…`), and every payment is a vault **receipt**:
the request creates a receipt naming its movements, the vault settles it ledger-to-ledger, and
settling calls back into the game inside the same instruction. A dropped settle pays nothing
and creates nothing, which is what makes the flow safe to retry.

## Accounts

| PDA | What |
| --- | --- |
| `["config"]` | The shelf: every card's blocks, pay table, pool, chances — all public. Grows, never shrinks. |
| `["house"]` | The game's own payer inside the rollup: sponsors each card's ephemeral rent and the VRF fee. Owns the house ledger (the payout float). Delegated to the TEE. |
| `["jackpot"]` | Owns the jackpot ledger — the progressive pot, fed 10% of every sale. The PDA itself stays on basenet; its ledger is public and delegated. |
| `["analytics"]` | Lifetime counters — sales, jackpots, payouts per mint — written only by the settle callbacks, so every number is settled money. Delegated; TEE reads restricted to the admins. |
| `["card", user]` | One card per user, **ephemeral** — it exists only on the rollup. Status: Bought → Requested → Revealed → Collected. Carries its own terms, copied from the shelf at purchase, so a rebalance can't rewrite a ticket someone owns. |
| vault: `["ledger", owner]` | Balances for player / house / jackpot, per mint (SOL is the all-zero mint at slot 0). |
| vault: `["receipt", program, consenter]` | One in-flight payment, consented by the session key. |

## Instructions

Each number is the little-endian u64 an instruction starts with, pinned per method in `src/lib.rs`
with `#[instruction(discriminator = N)]` — the numbers the program has always had. 0 is a deployed
no-op (the TEE admission probes send it), and so is every retired gap (5, 6, 8, 10, 11, 13, 14,
19, 23), as it always was; anything past 30 is refused.

| # | Name | Notes |
| --- | --- | --- |
| 1 | Initialize | Admin, idempotent: config shelf + house/jackpot/analytics PDAs, and the analytics TEE permission (members enforced on every run). The card count never shrinks. |
| 2/3/4 | Delegate / Undelegate / RequestUndelegation | Admin-gated; any game PDA (house, analytics) to the TEE. |
| 7 | CloseCard | Admin escape hatch for a stranded card; rent returns to the house. |
| 9 | SetCard | Admin: one card of the sheet, rewritten in place. |
| 12 | CallbackReveal | The VRF identity writes the 32-byte seed; status → Revealed. Scratching is pure client. |
| 15–22, 30 | Ledger ops | Open / delegate / close / authorize / privacy / undelegate the house and jackpot ledgers; WithdrawHouse (17); ReadJackpot (21). Admin-gated. |
| 24 | RequestPurchase | Session key consents. Receipt: price − take → house, take (10%) → jackpot. Callback = 27. |
| 25 | RequestCollect | Evaluates the revealed card. Receipt: winnings house → player, pot → player on a jackpot line. Callback = 29. |
| 26 | GrowConfig | Admin: grow the shelf. |
| 27 | ResolvePurchase | Settle callback: creates the ephemeral card with its terms; counts the sale in analytics. |
| 28 | RequestReveal | Permissionless and retryable (from Bought *or* Requested): CPI to MagicBlock VRF. |
| 29 | ResolveCollect | Settle callback: closes the card; counts the payout in analytics. |

## The engine

`engine/` (the `scratch-engine` crate) deals a card and values it; the client runs the
same crate compiled to wasm, and `src/utils/engine.rs` is only the adapter that hands it
an on-chain `CardConfig`. **The crate is the source of truth** — the client must derive
an identical card from the same seed, or a player scratches one card and is paid for
another.

The deal is deterministic: xoroshiro128++ seeded by folding all 32 seed bytes through
splitmix64 (using only the first 8 would cap the card space at 2⁶⁴), with weights drawn
against `TOTAL = 2³²` and no modulo.

What a card *is* comes from the published sheet, not from this code. `mode` and the block
roles (plate, number, mark, jackpot) decide the shape — a line, an anywhere-match, a duel
per row, a token hunt, a grid of paying lines — and every multiple is sheet data: a pay
entry's `mult`, the `LINEAR` flag that multiplies it by the group size, and a tier
`factor` for a slot multiplier. Re-rating a diagonal, changing what a match pays, or
retiring a card is a `SetCard`, never a code change. The shelf currently publishes four
cards; how it is balanced and published is `RUNBOOK.md`.

## Build & test

```
cargo build-sbf                              # target/deploy/scratch_cards.so
cargo +1.89.0-sbpf-solana-v1.52 test         # engine determinism/rate tests, layout + wire pins
scripts/parity.sh                            # the built .so against the deployed one: every
                                             # instruction and mutation, byte for byte
SBF_OUT_DIR=$PWD/target/deploy cargo test --test program -- --ignored
                                             # the built .so in Mollusk: dispatch, refusals, VRF, pot
```

The `.so` must stay within the mainnet program account (323,216 bytes of ProgramData, 45 of
them the loader's header): the rollup clones the program at its first-seen size. Check
`ls -l target/deploy/scratch_cards.so` before any upgrade.

Operating the live game — balancing cards, publishing the sheet, house float, app
builds — is `RUNBOOK.md`.

(Host `cargo test` needs rustc ≥1.89; the solana-bundled toolchain works.)
