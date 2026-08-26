# Audit — 2026-08-15, re-verified 2026-08-26

Scope: `scratch-cards-program/src` (all instructions, state, utils), `engine/src`, and the
`vault-program` receipt/settle path it depends on. Read against the deployed build
(game `GURqY…`, deployed 2026-08-14).

> **Re-verified against current code on 2026-08-26, after the game went live on mainnet.**
> Every status line below was checked against the source rather than trusted. It found that
> several items describe code that no longer exists (the whole `buy_card` era), so their bodies
> are stale even where the status is right. Items rewritten or re-statused: 3, 4, 5, 6, 7, 8, 9,
> 10, 12; new items 13 and 14 added.
>
> Item 13 was first written up as a 🔴 that let a stranger destroy a player's winnings. **That was
> wrong** — it was reasoned from the source without testing the runtime, and a receipt cannot
> outlive the transaction that creates it, which blocks the whole attack. It is recorded at its
> real severity below, with the mistake left visible.

Each item below is self-contained — location, what breaks, and what to do — so they can be
taken in any order. Severity order is the recommended order.

**Item 1 blocked mainnet and is fixed.** Items 2–4 rode along with it.

> **See "Design — settle-callback receipts" at the bottom before starting item 1.** That design
> was worked out after the audit and supersedes the per-item fixes for 1, 2 and 5, and the nonce
> half of 6. It touches the vault as well as the game, so it is a bigger change than any single
> item here — the per-item fixes are kept below as the fallback if you'd rather unblock mainnet
> without a vault redeploy.

---

## 1. 🔴 A settled receipt is not bound to the card it buys

- [x] Fixed — settle-callback design, 2026-08-15
- [ ] Test added

**Where:** `src/instructions/buy_card.rs:57-68`, `src/utils/receipt.rs:85`

`buy_card` proves only that *some* receipt at `["receipt", house, nonce]` was settled. It never
checks **which card** was paid for.

```rust
if *receipt_account.key != receipt::address(house.key, self.nonce) { … }
receipt::require_settled(receipt_account, program_id)?;   // ownership only
…
let terms = *Config::card(config_account, self.card_id)?; // caller-supplied card_id
```

`require_settled` compares owners and nothing else — and it *cannot* do more. The vault zeroes
the receipt before handing it back (`vault-program/programs/vault/src/instructions/receipt.rs:246`),
so by the time `buy_card` sees it, the payer, mints and amounts are all `0x00`. `price_paid` is
written to the card and never read by anything.

`card_id` in `request_purchase` and `card_id` in `buy_card` are therefore two independent,
unchecked inputs.

### Exploit

One transaction, self-signed throughout — same shape as the legitimate flow in
`scripts/play-devnet.mjs:401-403`, one differing `u64`:

```
requestPurchase(user=me, cardId=0, nonce=N)   // straight — 0.002 SOL
settleReceipt(nonce=N, consenter=me)          // I consent, I pay 0.002 SOL
buyCard(user=me, cardId=4, nonce=N)           // vault — 0.25 SOL card
```

The card is created carrying card 4's terms (`Card::write_terms`), and `request_collect` pays out
from that copy. Against the configured sheet (`scripts/setup-devnet.mjs:53-63`) that is a **125×
price substitution**: 0.002 SOL buys a ticket with a 45% win rate and vault-sized amounts,
~0.20 SOL expected return at the 80% RTP. Repeatable until the house ledger is empty.

**Second drain in the same call** — `buy_card.rs:69-81` computes the jackpot cut from the
*claimed* price and settles it `house → jackpot`:

```rust
let take = price * JACKPOT_SHARE_BP / 10_000;   // 0.025 SOL
```

The house pays 0.025 SOL into the jackpot on a sale that brought in 0.002. Each exploit play is
−0.023 SOL from the house *before* any payout, and pumps a pot the attacker then farms at card 4's
`hitBp` of 250 — 125× card 0's rate.

### Fix

**Superseded — see "Design — settle-callback receipts" below.** That design removes the zeroing
entirely, so the game reads the terms out of the receipt the vault wrote instead of re-supplying
them. What follows is the game-only fallback, which unblocks mainnet without touching the vault.

The binding has to live in an account the game controls, since the receipt is zeroed. Recommended:
**move card creation into `request_purchase`.** It already reads `card_id` to price the receipt, so
let it write the card in that same instruction:

- `request_purchase` creates the card account with `status: Bought`, `user`, `card_id`,
  `price_paid`, and the terms copied out of the shelf.
- `buy_card` drops its `card_id` argument entirely: load the card, check `card.user == user` and
  `card.status == Bought`, require the receipt settled, compute `take` from `card.price_paid`, flip
  to `Requested`, fire the VRF.

Every field the payout depends on is then written by the instruction that priced the receipt.
This also closes item 2.

**Trade-off:** the house sponsors rent on abandoned intents (request without settle). The
alternative — a small `["intent", user, nonce]` account read and closed by `buy_card` — costs the
same and adds an account, so it is not obviously better.

**Note on sequencing:** `request_purchase` currently touches no ledger, which is what lets it reach
the vault by CPI at all (`request_purchase.rs:11-13`). Creating the card there does not change that
— the card is an ephemeral account, not a permissioned one — but it is worth re-checking against
the rollup's access filter before committing to the design.

### Test

`mollusk-svm` is already a dev-dependency. A `buy_card` test that settles a receipt priced from
card 0 and then calls `buy_card` with `card_id = 4` must fail. See item 11 — there is currently no
instruction-level coverage at all, and this is exactly what would have caught it.

---

## 2. 🟠 `buy_card` takes no signature and never checks `user`

- [x] Fixed — `buy_card` is gone; the buyer is the receipt's `human`

**Where:** `src/instructions/buy_card.rs:43`

Same root cause as item 1. `user` is unchecked, so the card lands at `["card", <whatever pubkey was
passed>]`. `buy_card` requires no signature at all — deliberately, per its doc comment: "the player
consented when the receipt was written."

The devnet client bundles request → settle → buy atomically (`play-devnet.mjs:401-403`), which
closes the window today. Nothing in the program requires that. If the Android client ever splits or
retries the three steps, a stranger claims the settled receipt and receives the card; the victim
paid and their own `buy_card` then fails because the receipt is closed.

**Fix:** resolved by item 1 — binding `user` at request time. Under the settle-callback design it is
resolved more strongly: the beneficiary comes from the receipt's own `human` field, written by the
vault, so it is never caller-supplied at all. If item 1 is deferred for any reason, this needs its
own check.

---

## 3. 🟠 `RequestUndelegation` (variant 4) is ungated

- [x] Fixed — admin-gated at `src/instructions/delegation.rs:89-92`. The PDA itself is still
      unvalidated against a known seed (the second half of the fix below), but only an admin
      can reach it. Note the vault's own undelegate is now permissionless *by design*, so the
      house **ledger** remains publicly undelegatable — same DoS shape, relocated and accepted.

**Where:** `src/instructions/delegation.rs:88-97`

```rust
let [payer, pda, magic_context, magic_program, ..] = accounts else { … };
commit_and_undelegate_accounts(payer, vec![pda], magic_context, magic_program, None)
```

No admin check, no PDA validation. Anyone can pass `["house"]` and schedule its
commit-and-undelegate. No card can settle until admin re-delegates — `settle` needs both ledgers
live on the same validator.

Pure DoS, no fund loss, one transaction's cost.

**Fix:** gate on `ADMIN_PUBKEY` like the treasury instructions do, and validate the PDA against a
known seed rather than accepting an arbitrary account.

---

## 4. 🟡 `Delegate` (variant 2) is ungated with caller-supplied seeds

- [x] Fixed — admin-gated at `src/instructions/delegation.rs:25-28`. Seeds are still taken
      from instruction data, but only an admin can reach it.

**Where:** `src/instructions/delegation.rs:21-52`

Any signer can call it with arbitrary `pda_seeds` and an arbitrary `owner_program` account. It will
delegate any not-yet-delegated PDA of this program.

The validator is hardcoded to `TEE_VALIDATOR` (`DelegateConfig`), so it cannot be redirected to an
attacker's validator — that limits this to griefing. But note `delegate_account` **zeroes the PDA's
data** before handing it over (SDK `cpi.rs:90-93`), so this is a free disruption during any
maintenance window where config or house is home on basenet.

**Fix:** admin-gate it, and validate the seeds against the set this program actually delegates
rather than taking them from instruction data.

---

## 5. 🟡 Receipt-nonce collision — atomicity is load-bearing but unenforced

- [x] Fixed. The nonce is gone and the named mechanisms are real: refuse-to-overwrite-a-live
      receipt (`vault .../create_receipt.rs:79-89`) and same-slot expiry
      (`vault .../settle_receipt.rs:35-37`), with abandoned receipts self-reaping
      (`reap_receipt.rs`, scheduled at `create_receipt.rs:124`). Stronger than documented: a
      receipt is funded by its own data account, so the runtime rejects any transaction that
      creates one without closing it — create and consume are inseparable, and the
      abandoned-receipt case this item worries about cannot be constructed at all.

**Where:** vault `instructions/create_receipt.rs:79-89`, `settle_receipt.rs:35-37`

The vault deliberately overwrites an open receipt at the same nonce:

> "An existing open receipt at the same nonce is overwritten — only this authority can ever write at
> its own addresses, and the real flows create and settle in one transaction, so whatever was
> sitting there is debris from a flow that never finished."

`request_collect` is permissionless and `receipt_nonce` is caller-chosen. If a collect is ever *not*
atomic with its settle, a second `request_collect` at the same nonce overwrites the pending payout —
and the victim's card is already `Collected` (`request_collect.rs:63`), so it cannot be re-requested.
The winnings are gone permanently.

Client nonces are `(Date.now() + n) * 4 + 1` (`play-devnet.mjs:377, 418`) — guessable. Atomic
bundling is the only thing preventing this, and it is a client convention, not a program invariant.

**Fix:** **superseded — see the settle-callback design below**, which removes the nonce entirely and
replaces "always overwrite" with "refuse to overwrite an unexpired open receipt". The standalone
fallback is to derive the receipt nonce from the card rather than accepting it as input, so a second
request cannot land on a nonce the attacker chose. Note the purchase already uses the card's own
nonce address, which is why the collect nonce exists as a separate parameter — a derivation like
`hash(card_key, purpose)` would keep them distinct without being caller-controlled.

---

## 6. 🟡 The card PDA is missing the nonce its docs and parameters promise

- [ ] Fixed — **partially done.** The dead instruction params are gone, and so is the
      `Card.nonce` field itself (`src/state/card.rs:23-30`, pinned by `tests/layout.rs:35` at
      `Card::SIZE == 96`); the doc comment now matches the code. Still open: the card PDA is
      `["card", user]`, so the VRF `caller_seed` is constant per user for every card they ever
      buy (`src/instructions/request_reveal.rs:41`).

**Where:** `src/state/card.rs:18` (doc) vs `buy_card.rs:62`, `request_collect.rs:60-61`,
`collect.rs:54-55` (code)

`state/card.rs:18` documents `["card", user, nonce]`. Every handler derives `["card", user]`.

Three consequences:

1. One live card per user at a time.
2. `Collect.nonce` and `RequestCollect.nonce` are dead parameters — parsed, never used.
3. The VRF `caller_seed` is `card_account.key` (`buy_card.rs:112`), which is therefore **constant
   for a given user across every card they ever buy**.

(3) is not currently exploitable — the oracle mixes in its own entropy — but it removes the
per-purchase entropy contribution the design clearly intended.

**Fix:** either add the nonce to the seeds (restoring the documented behaviour and per-card
`caller_seed`), or delete the parameters and correct the comment. Adding it also removes the
"user can never buy again" amplifier in item 7.

---

## 7. 🔵 `set_card` validates only `pool.len()`

- [x] Fixed — superseded by the declared-odds card model, then genuinely covered. `validate()`
      (`src/instructions/set_card.rs:72-207`) checks mode and roll, block roles, an exact
      `WEIGHT_TOTAL` pool partition, tier and jackpot bands, zero-amount prizes and duplicate
      mints, with rejection tests at `:358-380`. **The body below is obsolete**: `kind`,
      `win_bp`, `mult_bp` and the near/hit threshold ordering no longer exist — the bands are
      exclusive and drawn by `rng.pick` (`engine/src/lib.rs:313`), not compared.

**Where:** `src/instructions/set_card.rs:48-50, 79-91`

`kind` is cast `u8 → u64` unchecked. A card published with `kind > 4` is **buyable** — `buy_card`
never evaluates the engine — but `engine::evaluate` rejects it at collect
(`engine/src/lib.rs:48-57`). The card sticks at `Revealed` forever, the money is gone, and because
the PDA has no nonce (item 6) **that user can never buy again**.

Also unchecked:

- `win_bp` / `jackpot_near_bp` / `jackpot_hit_bp` / `mult_bp` are `u16` and can exceed 10000.
  `roll_bp()` returns 0..9999, so any value ≥ 10000 means "always".
- Nothing requires `jackpot_near_bp > jackpot_hit_bp`. The deal tests hit first
  (`engine/src/lib.rs:233-235`), so inverting them silently kills the near-miss branch.

Cheap guards; permanent consequences for a fat-fingered admin transaction.

**Fix:** validate `kind <= 4` and clamp/reject bp values above 10000 in `set_card`. Consider
rejecting `pool_len == 0` too — it makes `jpick` return `SOL_MARK` for every jackpot cell
(`engine/src/lib.rs:222-231`), i.e. a guaranteed jackpot on every card.

---

## 8. 🔵 RNG discards 24 of the 32 VRF bytes

- [x] Fixed — `engine/src/rng.rs:22-39` folds all four u64s into 128 bits of state, handles
      xoroshiro's forbidden all-zero state at `:34-37`, and has a test that every seed byte
      moves the stream at `:115-123`. (`src/utils/rng.rs` no longer exists; the code lives
      only in the engine crate.)

**Where:** `src/utils/rng.rs:19-23`, `engine/src/rng.rs`

```rust
pub fn from_bytes(seed: &[u8; 32]) -> Self {
    let mut x = [0u8; 8];
    x.copy_from_slice(&seed[..8]);
    Self::new(u64::from_le_bytes(x))
}
```

Caps the outcome space at 2⁶⁴. Not a practical break, and not currently reachable — but free to fix
by folding all four u64s into the seed.

**Caution:** this changes every card's layout for a given seed. The client runs the same crate as
wasm, so both sides move together, but `engine/tests/vectors.rs` fixtures need regenerating and any
in-flight card at upgrade time changes outcome.

---

## 9. 🔵 `overflow-checks` is off

- [x] Fixed by the alternative this item recommends: the payout arithmetic saturates rather
      than relying on the flag (`engine/src/lib.rs:259, 620, 647, 659, 692, 696`; the take at
      `src/instructions/request_purchase.rs:37`; the analytics counters at
      `src/state/analytics.rs:61, 73`). `overflow-checks` itself is still absent from
      `Cargo.toml` — deliberate, since a panic in the engine is a stuck card.

**Where:** `Cargo.toml` (no `[profile.release]` section)

Release default is `overflow-checks = false`, so arithmetic wraps silently. Two spots in the engine:

- `amount_of(card, cells[i]) << (n - 3)` — `engine/src/lib.rs:274`, shift up to 6
- `amount_of(card, a) * line_mult` — `engine/src/lib.rs:301`

Amounts are admin-set and small today, so this is a guardrail question rather than a live bug. Note
the program-side `take = price * JACKPOT_SHARE_BP / 10_000` (`buy_card.rs:69`) is in the same
category.

**Fix:** add `[profile.release] overflow-checks = true`, or make the two engine sites saturating.
Prefer saturating in the engine — a panic there is a stuck card, per item 7.

---

## 10. 🔵 `Config` and `Card` accessors launder `RefCell` lifetimes

- [ ] Fixed — still open, and now wider: the same transmute-past-the-guard is in
      `src/state/config.rs:186, 198, 221, 232`, `src/state/card.rs:44, 55` and now
      `src/state/analytics.rs:50`. The live double-borrow site moved to
      `src/instructions/set_card.rs:243` + `:281`.

**Where:** `src/state/config.rs:107-161`, `src/state/card.rs:46-56`

Every accessor takes a `Ref`/`RefMut` from `try_borrow_data()` and then transmutes past the guard to
return a `&'a` that outlives it:

```rust
let mut data = account.try_borrow_mut_data()?;
…
.map(|r| unsafe { &mut *(r as *mut CardConfig) })
```

Consequence: `set_card` holds a live `&mut CardConfig` (`:79`) and a live `&mut Config` (`:95`) into
the same account simultaneously. The regions are disjoint (header vs. slot), so there is no live
miscompile — but the runtime borrow check no longer protects any of these call sites, and the next
person to add a read between them gets no warning.

**Fix:** scope the borrows and copy out, or keep the guard alive in the returned type. Low urgency,
but it is the kind of thing that turns a future edit into a silent aliasing bug.

---

## 11. 🔵 No instruction-level tests on the money path

- [ ] Fixed — still open. `mollusk-svm` is a dev-dependency with zero uses (`Cargo.toml:34` is
      its only occurrence). `tests/` is `layout.rs` and `vectors.rs`; unit tests live in
      `set_card.rs:350-380` and `engine/src/rng.rs:94-141`. The four cases below need
      rewriting — three name `buy_card`/`collect`, which are gone. The current equivalents:
      `resolve_purchase` without the vault-authority signature fails; `request_collect` by a
      non-owner fails (**item 13 — it does not**); `request_collect` twice fails.

**Where:** `tests/` — `engine.rs`, `layout.rs`, `vectors.rs`

`mollusk-svm` is a dev-dependency but nothing exercises an instruction. Coverage is the engine's
determinism and the byte layout only.

Item 1 is exactly what a single `buy_card` test would have caught. Minimum worth having:

- `buy_card` with a `card_id` that does not match the settled receipt → fails
- `buy_card` with a `user` that does not match the receipt's payer → fails
- `collect` on a card whose receipt was never settled → fails
- `request_collect` twice on the same card → second fails

---

## 12. 🟡 The session key does not have owner parity across the vault

- [ ] Fixed — still open, and the body is now partly obsolete. Parity today: `settle_receipt`
      honours the session key (`vault .../settle_receipt.rs:102`); plain `settle` honours it on
      the credit side (`settle.rs:57-58`) but **not** on the debit side (`:32-34`); `withdraw`
      does not (`withdraw.rs:32-47`). Two corrections: `for_authority` no longer exists
      anywhere in the vault — `authorized` is an unscoped session key
      (`vault .../state/ledger.rs:37-38`), which is a **new exposure in its own right** (see
      item 14) — and option (b) is now blocked, because `scripts/top-up.mjs:320` debits the
      admin's human ledger through plain `settle` to fund the house.

**Where:** `vault/instructions/settle.rs:38`, `vault/instructions/withdraw.rs:13-20`

Found 2026-08-15, after the main pass. The original audit checked whether each authorisation
check was *sound*; it did not check whether the authority model was *consistent* across them.

An authorized session key is meant to act as the owner in everything except changing the
authorization itself. It does not:

- **`settle_receipt`** honours it (`read_authorization`, matched on `for_authority`). ✔
- **plain `settle`** does not — `require_keys_eq!(src_authority.key(), src.owner)`.
- **`withdraw`** does not — `owner: Signer` + `has_one = owner`.

(`assign_ledger_authorization` is owner-only by design — that is the carve-out. `deposit` and
`close_ledger` are structural, not parity gaps.)

**For plain `settle` the gap is not arbitrary — it is the program lock.** `authorize.rs:15-18`:

> "The authority lock is what bounds a stolen session key. Unscoped, a leaked key could consent
> to a debit toward any program — including one deployed just to receive it and withdraw."

`settle_receipt` can enforce that because the receipt names its authority. Plain `settle` has no
receipt and therefore nothing to check `for_authority` against, so admitting the session key
there as-is would enable exactly the attack the lock exists to prevent.

**Fix — two coherent options:**

**(a) Give `settle` the scope.** Take `member_program` + `dst_owner_seeds`, run
`verify_pda_owner`, require it to equal `for_authority`. Full parity, lock intact, same proof
pattern as the rest of the vault.

**(b) Forbid human debits in plain `settle` entirely.** Then no owner-only power exists for the
authority to be missing — every human debit goes through a receipt, where parity already holds.

Prefer **(b)**: nothing appears to use what it removes. Every human↔program movement in this
system already goes through receipts, and the human side of plain `settle` only ever appears as
a *credit* (`withdraw_house` debits the house and credits admin, needing no human signature).
Confirm that against any other vault consumer before committing to it.

**`withdraw` is separate.** The blocker is that the destination is derived from the signer, so a
session key would withdraw to itself. Pinning it to `ledger.owner` makes the session key safe to
admit — the funds land with the owner either way. No use case today (basenet-only, session keys
are for in-play), but it is the same principle.

---

## 13. 🔵 `request_collect` marked the card collected before anything was paid

- [x] Fixed — the status write is gone; `CardStatus::Collected` no longer exists
- [ ] Test added

**Where:** `src/instructions/request_collect.rs`, `src/instructions/resolve_collect.rs`,
`src/state/card.rs`

`request_collect` flipped the card to `Collected` and then asked the vault for a receipt. That
label was simply false: nothing has been paid at that point. The payout happens in the settle
callback, `resolve_collect`, which is also what closes the card.

It compounded with a second oddity — the instruction requires *a* signer but never the card's
owner (`wallet` is bound only to the receipt address it seeds; `user` is checked as data). Read
together those two facts look like an attack: a stranger flips somebody's revealed card, never
settles, and the win is stranded forever behind a status that `request_collect` will not accept
again.

### Why that attack does not exist

**A receipt cannot outlive the transaction that creates it.** It is funded by its own data
account, so a transaction that creates one without closing it leaves the account short of rent
and the runtime rejects the whole thing. Verified on devnet: a lone `request_collect` fails with
`InsufficientFundsForRent`, and the card is untouched because nothing committed.

So `request_collect` can only travel bundled with its settle, and the settle is where consent is
enforced. Either it succeeds — and the movements name the card's *owner*, never the caller, so a
stranger's transaction just pays the rightful player — or it fails, and the flip reverts with it.

This was first written up as a 🔴 destroying player winnings. That was wrong, and wrong in an
instructive way: the reasoning was sound against the source and never checked against the
runtime, where an invariant the program does not state (create-and-consume are inseparable) does
the load-bearing work.

### What was changed anyway

The state was removed rather than the signature added. A card is collected when it is **gone**;
its existence is the unpaid flag. `request_collect` now reads the card through a new read-only
`Card::load` and writes nothing, `resolve_collect` expects `Revealed`, and the `Collected`
variant is deleted. Double payment is still impossible: the first settle closes the card, so any
second one cannot load it. The client never observed the status, so nothing outside changed.

Deployed to devnet 2026-08-26 and exercised end to end (buy → VRF → collect, wins and losses).
**Deliberately not deployed to mainnet**: with no vulnerability to close, a redeploy buys nothing
that justifies touching a live program. Mainnet runs the older binary, which behaves identically
from outside — the client never read the status — so the two clusters differ only in a state
nothing observes. The change rides along with the next mainnet deploy made for another reason.

---

## 14. 🟡 The vault session key lost its program scope

- [ ] Fixed

**Where:** `vault .../state/ledger.rs:37-38`, `authorize.rs:36-40`, `settle_receipt.rs:102`

Found 2026-08-26. Item 12 was written when a ledger's authorization named the program it was for
(`for_authority`), and its reasoning leaned on that lock: a leaked session key could only consent
to debits toward the one program it was scoped to. **`for_authority` no longer exists.**
`authorized` is now a bare pubkey, and `settle_receipt` does not check the receipt's
`member_program` against it.

So a leaked session key can now consent to a receipt naming *any* member program — precisely the
attack the deleted comment in `authorize.rs` described. Whether that matters depends on the
member set; today it is small and all ours, which is presumably why the scope was dropped. It
should be a recorded decision rather than an unremarked deletion, and it wants a note wherever
session keys are minted.

---

## Design — settle-callback receipts

Worked out 2026-08-15, after the audit. Spans both programs.

**Status: implemented 2026-08-15; deployed and live on mainnet since 2026-08-25.** Several
load-bearing details landed differently from the description below — the vault zeroes the receipt
discriminator rather than stamping it, the game never reads the receipt (authentication is solely
the vault-authority signature), the vault closes the receipt itself, receipts are seeded
`["receipt", member_program, consenter]`, and abandoned receipts self-reap. Read the code, not
this section, for the wire. Formerly: not yet deployed and
not yet exercised end to end — the client scripts still speak the old three-instruction flow and
need updating before anything can run. Steps 1–5 of the order below are done; step 6 (the card
PDA's nonce) is not — see item 6.

Retires items **1**, **2**, **5**, and the nonce half of **6**. Because it changes `create_receipt`
and `settle_receipt`, it is a change to the shared vault — every consumer inherits it.

### The problem

A receipt today proves only that *something* at `["receipt", house, nonce]` was settled. It cannot
prove more, because `settle_handler` zeroes the account before reassigning it (an account's owner
may only change while its data is all zeros). Everything the game needs — who paid, for what, how
much — is gone by the time the game can look, so it re-supplies all of it as unchecked instruction
data. That is item 1.

### The shape

Three top-level instructions become two. `buy_card` disappears as a top-level instruction.

**ix1 — game top-level:** `request_purchase` → CPI → `vault.create_receipt`, now also carrying the
callback discriminator, the callback args (`card_id`), and a **proven** member program.

**ix2 — vault top-level:** `settle_receipt`
1. validate and move balances (as today)
2. stamp `d[0] = RECEIPT_SETTLED` — **do not zero, do not reassign**
3. CPI into the proven program's `resolve_receipt`
4. the game reads the receipt, does the work, and closes it with the house sponsor seeds
5. assert the receipt is gone, or revert

### Why the callback authenticates

Inside `resolve_receipt` the game checks:

- the account is at `["receipt", authority, human]` derived under `VAULT_PROGRAM` — recomputable
- it is **owned by the vault**
- `d[0] == RECEIPT_SETTLED`

Only the vault can write that byte, and a SETTLED receipt exists only between step 2 and step 4 of
one instruction. A direct call to `resolve_receipt` can never present one.

Note this is the **opposite** of today's `require_settled`, which reads *owned by vault = not yet
paid*. Same account, inverted meaning. Getting it backwards during the port is a total bypass rather
than a visible failure — comment it loudly.

### Why the data is trustworthy

Because nothing is zeroed, the game reads `human`, the movements and its own args **out of the
account the vault owns and wrote**. Instruction data is advisory at most and can be ignored.

This is the load-bearing improvement. Every earlier version of this design had the args arriving as
CPI parameters, which made "the receipt was settled" and "these args are what it said" two separate
claims that had to be welded together by closing the receipt. Keeping ownership with the vault
makes them the same claim.

**In particular, `human` must come from the receipt, never from the args.** That is what makes an
overwrite unable to redirect a card to someone else.

### The callback target must be proven, not derived

Do **not** take it from `*authority.owner` at settle time. That field is not stable, and the vault
already records being bitten by exactly this (`open_pda_ledger.rs:14-19`):

> "Reading the program off the owner account's `owner` field ... was correct only by timing:
> delegation and reassignment change that field, and the house ledger once ended up naming the
> delegation program instead of its game."

Delegate the house and `authority.owner` becomes the delegation program.

Use the pattern already written for this: `create_receipt` takes `member_program` + `authority_seeds`,
calls `verify_pda_owner` (the seeds must derive the authority under that program), and stores the
proven program id in the receipt. Settle CPIs into the stored value. Naming someone else's program
then requires producing that program's PDA signature, which only it can do.

Without this, anyone can create a receipt naming any program as the callback target and have the
vault CPI into it with a receipt that program will read as authentic.

### Closing, and why the vault does not sponsor

Closing an ephemeral account needs **only the sponsor's signature** — the owner is not consulted.
From the SDK (`ephemeral_accounts.rs:9-11`):

> "**Ephemeral**: Must be a signer only on `create` (prevents pubkey squatting). Not required to
> sign on `resize` or `close`."

Account list is `[sponsor(signer,w), ephemeral(w), vault(w)]`.

So the game closes the receipt **while the vault still owns it**, with the house seeds, exactly as
`receipt::close` does today. Ownership never changes; `fill(0)` and `assign` are deleted, not
reordered. Rent still returns to the house, so the vault needs no float of its own — a vault-side
rent treasury was considered and rejected on that basis.

**The vault's post-CPI assertion is load-bearing.** A callback that returns without closing leaves a
SETTLED, vault-owned receipt alive past the instruction, which is precisely the replay token this
design exists to prevent. The vault must check and revert.

⚠️ Verify what `CloseEphemeralAccount` actually leaves behind — data length zero, lamports zero, or
the account fully gone — before choosing the predicate. That check is the only thing between a buggy
callback and a forgeable receipt.

### Receipt addressing

Drop the nonce. Go to `["receipt", authority, human]`.

The original intent was one live receipt per player, where overwriting is safe because anything
sitting there is your own abandoned debris. The nonce broke that — it gives an unbounded set of
addresses per player — and `human` was never a seed at all, only data at `d[1..33]`. This restores
the intent and makes the address itself say who it is for.

### Expiry

Stamp the slot at creation; `settle_receipt` requires the same slot.

The point is **not** that it blocks an attacker — same slot is not the same transaction, so two
transactions can still land in one tick. The point is that a client which splits create and settle
across slots now fails loudly, every time, so nobody can accidentally adopt the vulnerable pattern
and have it appear to work.

It also earns something better: an expired receipt is *provably* dead and an unexpired one
*provably* live, so `create_receipt` can flip from **always overwrite** to **refuse to overwrite an
unexpired OPEN receipt**. That closes item 5's class outright rather than narrowing it.

⚠️ Verify the ER's `Clock` semantics first. Settle runs in the rollup and the whole guarantee rests
on slot numbers advancing sanely there. If the ER clock stalls or jumps, this either bricks
purchases or protects nothing.

### What stays out of the callback

The VRF request moves to its own later instruction — it is not part of `resolve_receipt`. This also
removes most of the compute pressure on the callback frame.

**Consequence to design for:** a card can then exist, paid for, with no randomness ever requested.
Make that instruction permissionless and retryable off the card's own state, or a paid card can be
stranded by nobody submitting it.

### Reentrancy

The receipt stays valid-and-SETTLED for the entire callback frame, so anything re-entering the
callback within it sees a receipt that still authenticates. The callback must be idempotent.

For the buy path the existing `card_account.data_len() != 0 → AlreadyInitialized` covers it — but
that is currently load-bearing by accident. Make it an explicit, commented guard.

### Permission precondition

Everything the callback touches must have the vault as a member. The vault is *implicitly* a member
of ledgers it owns (the explicit `[member_program, payer]` list in `open_pda_ledger` is additive),
which is why `settle_receipt` reaches the house ledger today.

This is an acceptable constraint, but write it down: the failure mode is a runtime filter rejection
in the rollup with nothing pointing at the cause. A future callback reaching for some other
program's permissioned account will simply start failing.

### Residual risk

The create→settle window is still two top-level instructions and nothing forces them into one
transaction. Expiry plus refuse-to-overwrite closes the exploitable version. Even without those,
sourcing `human` from the receipt means an overwrite can change *which card* a victim buys but never
*who receives it* — griefing, not theft.

Rejected along the way: requiring the human's authorization at *creation*. The authorization record
lives in the ledger (`settle.rs:203`), creation is game-top-level and therefore cannot include the
ledger, so creation can only verify the owner-signs case. That would force a wallet prompt per
purchase and break zero-prompt session-key play, which is the thing the session-key design exists to
provide. An unpermissioned `["auth", human]` mirror would make it work, but it duplicates state the
ledger already holds and should be scoped as a vault feature in its own right.

### Verify before coding

1. ER `Clock` semantics in the rollup (expiry).
2. What `CloseEphemeralAccount` leaves behind (the vault's assertion predicate).
3. Compute budget for the callback frame — jackpot settle + ephemeral card creation, nested under a
   vault that has already done its own work.
4. Other vault consumers — `create_receipt` and `settle_receipt` both change signature.

### Suggested order

1. Vault: expiry stamp + refuse-overwrite, still with today's zero-and-assign flow. Independently
   useful, ships alone.
2. Vault: `member_program` + `verify_pda_owner` on `create_receipt`, store the proven id.
3. Vault: replace zero-and-assign with stamp → CPI → assert-closed.
4. Game: `resolve_receipt` replaces `buy_card`; reads terms from the receipt; closes it.
5. Game: split the VRF request into its own permissionless, retryable instruction.
6. Game: drop the nonce from the receipt address and the dead nonce params (item 6).

---

## Out of scope for this pass

Carried over from the mainnet-readiness notes, unchanged and still open:

- **Balance/RTP is unreviewed** — 80% token RTP + 10% jackpot take is unexamined by design; the
  user wants to review balance themselves before launch.
- **Rebalancing is manual** — `rebalance.mjs --apply`, house top-up script, and the cron wrapper
  with dry-run diff + alerting are still to build. Guardrails live in the scripts, not the program.
- **The house is short an unhedged memecoin basket** — SOL in, tokens out. Open product question.
  The swap leg cannot be tested on devnet (own test mints, no market).
- **The app caches the card sheet at boot** — a mid-session rebalance is invisible until restart, so
  the shop can show numbers the chain disagrees with. Note item 1's fix does not change this;
  cards already carry their own terms, so the risk is display-only.
