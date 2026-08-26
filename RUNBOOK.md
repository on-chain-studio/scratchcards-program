# Runbook

How the live game is operated: changing the card sheet, publishing it, keeping the
house solvent, and shipping the app. `README.md` explains what the program *is*; this
explains what you *do*.

Every script takes `--mainnet`. Without it you are on devnet. The flag also picks who
signs and pays: devnet uses the dark-galaxy dev key, mainnet uses `~/casino_admin.json`
(`scripts/net.mjs`, `ADMIN_PATH`). Mainnet runs print a `■ MAINNET — real funds` banner.

---

## Changing the cards

The sheet lives in `tools/sheet/cards.json`; the knobs that generate it live in
`tools/sheet/design.json`. Both are written by the balancing tool — hand-editing them
is not the workflow.

```
cd tools/sheet && npx vite          # http://localhost:5180
```

1. **Update prices** (button, or `node scripts/fetch-prices.mjs`) — re-reads token
   prices. Prizes do not move yet.
2. **Rebalance all** — re-solves every card at the new prices and re-prints the sheet.
3. **Save** — writes `cards.json` and `design.json`.

Rebalance is the whole solve, and it owns more than it used to: `bend` is re-derived
from each card's win-rate aim, and the top prize's odds are derived from its printed
size. Neither is a stored preference any more, so a rebalance cannot drift off the
invariants below. What you actually steer is one number per card — `max`, the top
prize as a multiple of the ticket.

**If the tool has been open across a code change, hard-reload it and discard the
draft.** A stale tab runs old solver code against a `localStorage` draft, which has
silently produced wrong sheets more than once.

### The invariants the solver enforces

| | |
|---|---|
| RTP | exactly 80% on every card |
| Win rate | ~1 in 2.5 (`winOneIn`, per card) |
| Top prize odds | never rarer than 1:300k (`TOP_ONE_IN_CAP`, held at 280k for margin) |
| Top prize cost | 0.1% of every ticket (`TOP_EV_SHARE`) — so prize scales with spend |
| Ladder | monotone: a bigger prize is never more likely than a smaller one |

Consequences worth knowing before you tune:

- **A card's top prize is capped by its multiplier chain.** A card whose value spread
  lives in shallow multipliers cannot carry a big headline — the solver shrinks the
  prize rather than break the odds. The Vault tops out near $238 for this reason. Fixing
  that means deepening its printed line multipliers, not turning a knob.
- **Top prizes are deliberately sub-linear in ticket price.** Pricier cards buy better
  *odds* on the top rather than a proportionally bigger one. This is a decision, not
  drift — see the memory note before "correcting" it.

---

## Publishing the sheet

Devnet first, always. Both clusters run the same sheet.

```
node scripts/setup-devnet.mjs --cards-only              # publish to devnet
node scripts/_verify-sheet.mjs                          # must say: chain matches the sheet exactly
ROLLUP=tee node scripts/play-devnet.mjs 3               # buy/reveal/collect 3 real cards

node scripts/setup-devnet.mjs --cards-only --mainnet    # publish to mainnet
node scripts/_verify-sheet.mjs --mainnet
```

`_verify-sheet` decodes every field of every on-chain card and compares it to the
sheet — it is the only thing that proves a publish landed, so never skip it.

`play-devnet.mjs` plays as the dev key against a ledger that persists between runs;
`--close` undelegates, withdraws and closes it to reclaim the funds.

### Retiring or adding a card

`card_count` never shrinks on chain, so a retired slot cannot be deleted — the
publisher rewrites it as a copy of the last card, and both the verifier and the app
recognise and skip it.

To retire a card: delete it from `cards.json` and `design.json`, delete its `CardDef`
from `Cards.ALL` (`Symbols.kt`) in the app, then republish both clusters and rebuild the
app. The shelf the app draws comes from the published config; the app only supplies the
copy for a card id, so those two deletions are the whole job.

---

## Keeping the house solvent

The house must be able to pay the worst single collect of every token on the sheet.
Policy is a float of exactly ×1.0 of that worst case.

```
node scripts/_house-balances.mjs --mainnet                    # what the house holds
node scripts/top-up.mjs --mainnet --factor 1 --fill --check   # what it needs

node scripts/acquire-float.mjs --mainnet --factor 1           # plan the SOL → token swaps
node scripts/acquire-float.mjs --mainnet --factor 1 --swap    # execute them
node scripts/top-up.mjs --mainnet --factor 1 --fill           # move them into the house
```

Two flags are load-bearing:

- **`--factor 1`** on both scripts. They default to 1.5 and 5 respectively, which would
  buy several times the intended float.
- **`--fill`** on `top-up`. Its default refills only below *half* target — right for
  routine drift, wrong straight after `acquire-float`, which buys the exact shortfall
  to full target. Without `--fill` the tokens you just bought stay stranded in the
  admin wallet and the run reports "nothing to do".

Run the float check after any sheet change: bigger prizes mean bigger worst cases.

Devnet needs none of this — its pools are SOL-only, and the stand-in tokens are minted
by `top-up` rather than bought.

---

## The app

```
cd ../scratch-cards
./gradlew installDevnetDebug        # devnet build
./gradlew installMainnetRelease     # signed mainnet build (~/interstellar-dapps.keystore)
```

Both flavors share one application id, so only one is installed at a time.

**A sheet republish does not need an app build.** Prices, prizes, odds and which cards
exist all come from the on-chain config; the app carries only per-card copy and art.
Rebuild when app code changes.

---

## Watching it run

The sheet tool's **Analytics** tab shows the live counters (cards sold, SOL in, payouts,
jackpots) and graphs a chosen time range. History is recorded only while that dev server
is running — the chain holds lifetime totals, not a time series.

```
node scripts/_analytics.mjs --mainnet     # same counters, one shot
```
