// How to read the accounts this system stores. One copy.
//
// These layouts are defined in Rust and mirrored here, which means every script that spells the
// offsets out itself is a copy that can go stale on its own — and did. Adding `rent_payer` to the
// vault's `Ledger` shifted the header by 32 bytes and broke five scripts independently, plus the
// Android decoder hours later, each failing silently: a slot count read out of the middle of a
// pubkey is a number in the billions, and a balance read from inside one is zero.
//
// So: one decoder per account type, and callers ask it rather than the bytes.

import { PublicKey } from '@solana/web3.js';

/** `Ledger`: 8 discriminator + 32 owner + 1 pda_auth + 1 bump + 6 pad + 32 rent_payer + 4 slots. */
export const LEDGER_HEADER = 116;
export const LEDGER_ENTRY = 40;
/** Slot 0 is SOL from creation, so the balance is at a fixed offset rather than a scan. */
export const LEDGER_SOL_AT = LEDGER_HEADER + 32;

export const SOL_MINT = PublicKey.default;

/**
 * A vault ledger, or null if the account is too small to be one.
 *
 * Zero-amount slots and unused ones are dropped, except slot 0 — which is SOL whether or not it
 * holds anything, because that is what makes "a zero mint anywhere else means free" work.
 */
export function decodeLedger(data) {
  if (!data || data.length < LEDGER_HEADER) return null;
  const slots = data.readUInt32LE(LEDGER_HEADER - 4);
  const balances = {};
  for (let i = 0; i < slots; i++) {
    const at = LEDGER_HEADER + i * LEDGER_ENTRY;
    if (at + LEDGER_ENTRY > data.length) break;
    const mint = new PublicKey(data.subarray(at, at + 32));
    const amount = data.readBigUInt64LE(at + 32);
    if (amount === 0n) continue;
    if (i !== 0 && mint.equals(SOL_MINT)) continue;   // an unused slot, not SOL
    balances[mint.toBase58()] = amount;
  }
  return {
    owner: new PublicKey(data.subarray(8, 40)),
    pdaAuth: data[40] === 1,
    bump: data[41],
    rentPayer: new PublicKey(data.subarray(48, 80)),
    authorized: new PublicKey(data.subarray(80, 112)),
    slots,
    balances,
    sol: data.readBigUInt64LE(LEDGER_SOL_AT),
  };
}

/** `Card`: 8 discriminator + 8 version + 32 user, then the fields below. */
// No 'collected': a card is collected when it is closed, so a live card never holds that
// status. Marking one instead left a state anyone could strand — see request_collect.
export const CARD_STATUS = ['bought', 'requested', 'revealed'];

// The 96-byte reflow: `nonce` and `price_paid` are gone, pinned by tests/layout.rs.
export function decodeCard(data) {
  if (!data || data.length < 96) return null;
  return {
    user: new PublicKey(data.subarray(16, 48)),
    cardId: data.readBigUInt64LE(48),
    status: CARD_STATUS[Number(data.readBigUInt64LE(56))] ?? '?',
    seed: data.subarray(64, 96),
  };
}

/** `Analytics`: 6 u64 counters, 16+16 per-card slots, then 16 `[mint, amount]` payout rows. */
export const ANALYTICS_SIZE = 944;

export function decodeAnalytics(data) {
  if (!data || data.length < ANALYTICS_SIZE) return null;
  const cardSlots = (at) =>
    Array.from({ length: 16 }, (_, i) => data.readBigUInt64LE(at + i * 8));
  const payouts = {};
  for (let i = 0; i < 16; i++) {
    const at = 304 + i * 40;
    const amount = data.readBigUInt64LE(at + 32);
    if (amount === 0n) continue;
    payouts[new PublicKey(data.subarray(at, at + 32)).toBase58()] = amount;
  }
  return {
    lamportsIn: data.readBigUInt64LE(16),
    jackpotIn: data.readBigUInt64LE(24),
    jackpotPaid: data.readBigUInt64LE(32),
    jackpotHits: data.readBigUInt64LE(40),
    cardsSold: cardSlots(48),
    cardsCollected: cardSlots(176),
    payouts,
  };
}
