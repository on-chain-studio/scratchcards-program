// The deployed sheet, read back off chain, and the engine that values it.
//
// Balancing moved to tools/sheet — it solves the odds analytically, which sampling cannot beat
// now that they are declared rather than emergent. What is left here reads what is actually
// published, which is a different question from what the sheet says should be, and the only
// one worth sampling: scripts/top-up.mjs sizes house liquidity against real dealt outcomes.

import fs from 'fs';
import crypto from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { MAGIC_RPC, MINTS } from './net.mjs';

export const RPC = MAGIC_RPC;
export const PROGRAM_ID = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
export const JACKPOT_SHARE_BP = 1000;
/**
 * The share of a card's price returned as tokens.
 *
 * The jackpot is a payout too, so the player's total return is this plus the 10% take that
 * feeds the pot — every lamport of which comes back out when someone hits it. 80% here means
 * 90% returned and 10% kept — slot-machine territory, which is what a web3 audience
 * benchmarks against; physical scratchers keep far more, but they are not the competition.
 */
export const TARGET_RTP = 0.80;

export const MAX_POOL = 10;
export const MAX_CELLS = 32;

// One CardConfig as the account stores it — mirrors src/state/config.rs, same as _verify-sheet.
export const CARD_BYTES = 992;

const WASM_CANDIDATES = [
  'engine/target/wasm32-unknown-unknown/release/scratch_engine.wasm',
  '../scratch-cards/app/src/main/assets/scratch_engine.wasm',
];

export function loadEngine() {
  const path = WASM_CANDIDATES.find((p) => fs.existsSync(p));
  if (!path) {
    throw new Error('no scratch_engine.wasm — build it with:\n' +
      '  (cd engine && cargo build --release --target wasm32-unknown-unknown --no-default-features)');
  }
  const module = new WebAssembly.Module(fs.readFileSync(path));
  const instance = new WebAssembly.Instance(module, {});
  const at = instance.exports.buffer();
  const len = instance.exports.buffer_len();
  if (len !== CARD_BYTES + 32) {
    throw new Error(`engine buffer is ${len} bytes, expected ${CARD_BYTES + 32} — ABI drift`);
  }

  /**
   * One deal. The buffer is input *and* output — `deal_buffer` writes its result over the
   * card that produced it, so the card's raw bytes go in fresh every time. Views are taken
   * per call because wasm memory can grow, detaching any view held across calls.
   */
  const deal = (card, seed) => {
    const mem = new Uint8Array(instance.exports.memory.buffer, at, len);
    mem.set(card.raw, 0);
    mem.set(seed, CARD_BYTES);
    if (Number(instance.exports.deal_buffer()) !== 0) throw new Error('engine rejected the card');
    // len u16, body_len u16, cells as u16 — then jackpot u8, multiplier u32, pool amounts u64.
    const out = new DataView(instance.exports.memory.buffer, at, len);
    const o = 4 + MAX_CELLS * 2;
    return {
      jackpot: out.getUint8(o) !== 0,
      amounts: Array.from({ length: MAX_POOL }, (_, i) => out.getBigUint64(o + 5 + i * 8, true)),
    };
  };
  return { path, deal };
}

/** Deterministic, well-spread seeds — the same run twice gives the same answer. */
export const seedFor = (card, n) => crypto.createHash('sha256').update(`${card}:${n}`).digest();

export async function loadCards() {
  const conn = new Connection(RPC, 'confirmed');
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID);
  const info = await conn.getAccountInfo(configPda);
  if (!info) throw new Error('no config on chain — run scripts/setup-devnet.mjs');
  const d = info.data;

  const symbolOf = Object.fromEntries(Object.entries(MINTS).map(([sym, m]) => [m, sym]));
  // The all-zero mint is native SOL — no mint account exists for it to be listed under.
  symbolOf[PublicKey.default.toBase58()] = 'SOL';

  // discriminator, version, authority, card_count — then the cards. The raw bytes ride along
  // because the engine takes them verbatim; the parsed pool is only for naming and sizing.
  const HEADER = 56;
  const POOL_AT = 512;
  const count = Number(d.readBigUInt64LE(48));

  const cards = [];
  for (let c = 0; c < count; c++) {
    const raw = d.subarray(HEADER + c * CARD_BYTES, HEADER + (c + 1) * CARD_BYTES);
    const poolLen = raw.readUInt8(21);
    const pool = [];
    for (let i = 0; i < poolLen; i++) {
      const p = POOL_AT + i * 48;
      const mint = new PublicKey(raw.subarray(p, p + 32)).toBase58();
      pool.push({
        symbol: symbolOf[mint] ?? mint.slice(0, 6),
        amount: Number(raw.readBigUInt64LE(p + 32)),
        weight: raw.readUInt32LE(p + 40),
      });
    }
    cards.push({
      raw,
      priceLamports: Number(raw.readBigUInt64LE(0)),
      pool,
    });
  }
  return { configPda, cards };
}

/**
 * Base units per whole token — the mainnet decimals, on every network.
 *
 * Pool amounts are written in mainnet base units even though the devnet stand-ins are
 * 0-decimal throwaways, so the same sheet prints the same prizes on both networks. The
 * table comes off `prices.json._decimals`, which fetch-prices.mjs reads from the real
 * mint accounts; SOL is the fallback for a prices.json that predates the field.
 */
export const DECIMALS = {
  SOL: 9,
  ...(JSON.parse(fs.readFileSync('scripts/prices.json', 'utf8'))._decimals ?? {}),
};
export const decimalsOf = (symbol) => DECIMALS[symbol] ?? 0;
export const whole = (symbol, units) => units / 10 ** decimalsOf(symbol);

export function loadPrices() {
  const prices = JSON.parse(fs.readFileSync('scripts/prices.json', 'utf8'));
  const missing = new Set();
  const usd = (symbol, units) => {
    const p = prices[symbol];
    if (p === undefined) { missing.add(symbol); return 0; }
    return whole(symbol, units) * p;
  };
  return { prices, usd, missing };
}

/** Expected payout per card, in USD and per pool slot, over [samples] deals. */
export function measure(deal, card, usd, samples, index = card.kind) {
  const won = new Array(MAX_POOL).fill(0n);
  let hits = 0, jackpots = 0;
  for (let s = 0; s < samples; s++) {
    const r = deal(card, seedFor(index, s));
    if (r.jackpot) jackpots++;
    let any = false;
    for (let p = 0; p < MAX_POOL; p++) {
      if (r.amounts[p] > 0n) { won[p] += r.amounts[p]; any = true; }
    }
    if (any) hits++;
  }
  const perToken = card.pool.map((p, i) => ({
    symbol: p.symbol,
    amount: p.amount,
    perCardUsd: usd(p.symbol, Number(won[i]) / samples),
  }));
  return {
    perToken,
    payUsd: perToken.reduce((a, t) => a + t.perCardUsd, 0),
    hitRate: hits / samples,
    jackpots,
    samples,
  };
}

export const costUsd = (card, solUsd) => (card.priceLamports / 1e9) * solUsd;

/**
 * The nearest round number a prize would sensibly be printed as.
 *
 * A payout of 4713 BONK reads like a rounding error; 5000 reads like a prize. Scaling a card
 * moves every amount by the same factor, so snapping each one costs a little accuracy — which
 * is why the caller re-measures afterwards rather than trusting the arithmetic.
 */
export function nice(units, symbol = '') {
  if (units <= 0) return 0;
  const scale = 10 ** decimalsOf(symbol);
  const x = units / scale;               // snap what a player reads, not the base units
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];
  const base = 10 ** Math.floor(Math.log10(x));
  let best = null;
  for (const s of steps) {
    const v = Math.round(s * base * scale);
    if (v < 1) continue;                 // a prize cannot be less than one base unit
    if (best === null || Math.abs(v - units) < Math.abs(best - units)) best = v;
  }
  return best ?? 1;
}

/**
 * The worst single collect per symbol — a closed form off the published sheet, not a sample.
 *
 * An exclusive roll pays one rung, so the worst is the dearest multiplier. An independent roll
 * is one draw per rung, and every rung can hit in the same deal AND land the same token, so the
 * worst is the SUM of the multipliers — sampling always undershot that tail, which is exactly
 * the wrong direction for float sizing. Zero-weight rungs and pool entries cannot hit and are
 * excluded, which is also what keeps the devnet answer SOL-only for free.
 */
export async function worstCases() {
  const { cards } = await loadCards();
  const worst = {};
  const LINEAR = 2;
  for (const card of cards) {
    const raw = card.raw;
    const roll = raw.readUInt8(17); // 0 exclusive, 1 independent
    const mults = [];
    for (let i = 0; i < raw.readUInt8(19); i++) {
      const at = 96 + i * 12;
      if (raw.readUInt32LE(at + 4) === 0) continue;
      mults.push(raw.readUInt16LE(at + 10) * ((raw.readUInt8(at + 9) & LINEAR) ? raw.readUInt8(at + 8) : 1));
    }
    if (!mults.length) continue;
    const factor = roll === 1 ? mults.reduce((n, m) => n + m, 0) : Math.max(...mults);
    let topTier = 1;
    for (let i = 0; i < raw.readUInt8(20); i++) {
      const at = 480 + i * 8;
      if (raw.readUInt32LE(at + 4) > 0) topTier = Math.max(topTier, raw.readUInt32LE(at));
    }
    for (const e of card.pool) {
      if (e.weight === 0) continue;
      const w = BigInt(e.amount) * BigInt(factor) * BigInt(topTier);
      if (!(e.symbol in worst) || w > worst[e.symbol]) worst[e.symbol] = w;
    }
  }
  return worst;
}
