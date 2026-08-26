// Read-only: does the published shelf still say what tools/sheet/cards.json says?
//
//   node scripts/_verify-sheet.mjs
//
// Decodes every field of the on-chain card rather than a chosen few. The first version of this
// checked price, the jackpot bands, and the pool and pay weights — and reported "chain matches
// the sheet exactly" for a sheet whose blocks, scopes, multipliers and tiers had all been edited,
// because it never read them. A verifier that only checks the fields you thought to list gives
// its most convincing answer exactly when it is wrong.

import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { MAINNET, MAGIC_RPC as RPC, MINTS, poolWeights } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');

// Mirrors src/state/config.rs. The compile-time asserts there pin every one of these.
const HEADER = 56, CARD = 992;
const BLOCKS = 32, PAYS = 96, TIERS = 480, POOL = 512;

const ROLE = ['plate', 'number', 'mark', 'jackpot'];
const MODE = ['count', 'compare'];
const ROLL = ['exclusive', 'independent'];

const conn = new Connection(RPC, 'confirmed');
const pda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM)[0];
const info = await conn.getAccountInfo(pda);
if (!info) throw new Error('no config account');

const version = Number(info.data.readBigUInt64LE(8));
const count = Number(info.data.readBigUInt64LE(48));
const sheet = JSON.parse(fs.readFileSync('tools/sheet/cards.json', 'utf8'));
const mintOf = (t) => t === 'SOL' ? '11111111111111111111111111111111' : MINTS[t];

/** The whole card, as the account holds it. */
const decode = (b) => {
  const blockLen = b.readUInt8(18), payLen = b.readUInt8(19);
  const tierLen = b.readUInt8(20), poolLen = b.readUInt8(21);
  return {
    priceLamports: Number(b.readBigUInt64LE(0)),
    jackpotHitWeight: b.readUInt32LE(8),
    jackpotNearWeight: b.readUInt32LE(12),
    mode: MODE[b.readUInt8(16)],
    roll: ROLL[b.readUInt8(17)],
    modeArgs: [0, 1, 2, 3].map((i) => b.readUInt16LE(24 + i * 2)),
    blocks: Array.from({ length: blockLen }, (_, i) => {
      const at = BLOCKS + i * 8;
      return {
        role: ROLE[b.readUInt8(at)], count: b.readUInt8(at + 1),
        cols: b.readUInt8(at + 2), flags: b.readUInt8(at + 3),
        a: b.readUInt16LE(at + 4), b: b.readUInt16LE(at + 6),
      };
    }),
    pays: Array.from({ length: payLen }, (_, i) => {
      const at = PAYS + i * 12;
      return {
        scope: b.readUInt32LE(at), weight: b.readUInt32LE(at + 4),
        min: b.readUInt8(at + 8), flags: b.readUInt8(at + 9), mult: b.readUInt16LE(at + 10),
      };
    }),
    tiers: Array.from({ length: tierLen }, (_, i) => ({
      factor: b.readUInt32LE(TIERS + i * 8), weight: b.readUInt32LE(TIERS + i * 8 + 4),
    })),
    pool: Array.from({ length: poolLen }, (_, i) => {
      const at = POOL + i * 48;
      return {
        mint: new PublicKey(b.subarray(at, at + 32)).toBase58(),
        amount: Number(b.readBigUInt64LE(at + 32)), weight: b.readUInt32LE(at + 40),
      };
    }),
  };
};

/** The same card as the sheet describes it, in the shape `decode` produces. */
const fromSheet = (c) => ({
  priceLamports: c.priceLamports,
  jackpotHitWeight: c.jackpotHitWeight,
  jackpotNearWeight: c.jackpotNearWeight,
  mode: c.mode,
  roll: c.roll,
  modeArgs: c.modeArgs,
  blocks: c.blocks.map((b) => ({
    role: b.role, count: b.count, cols: b.cols, flags: b.flags ?? 0, a: b.a ?? 0, b: b.b ?? 0,
  })),
  pays: c.pays.map((p) => ({
    scope: p.scope, weight: p.weight, min: p.min, flags: p.flags ?? 0, mult: p.mult,
  })),
  tiers: c.tiers.map((t) => ({ factor: t.factor, weight: t.weight })),
  // Devnet publishes a SOL-only pool (see net.mjs poolWeights); the expectation follows it.
  pool: ((w) => c.pool.map((p, i) => ({ mint: mintOf(p.token), amount: p.amount, weight: w[i] })))(
    poolWeights(c.pool)),
});

const diff = (path, chain, want, out) => {
  if (Array.isArray(want) || (want && typeof want === 'object')) {
    if (Array.isArray(want) && Array.isArray(chain) && want.length !== chain.length) {
      out.push(`${path}: chain has ${chain.length}, sheet has ${want.length}`);
      return;
    }
    for (const k of Object.keys(want)) diff(`${path}.${k}`, chain?.[k], want[k], out);
    return;
  }
  if (String(chain) !== String(want)) out.push(`${path}: chain ${chain}, sheet ${want}`);
};

console.log(`config v${version}, ${count} cards on chain, ${sheet.length} in the sheet\n`);
let bad = 0;
for (let i = 0; i < Math.max(count, sheet.length); i++) {
  const c = sheet[i];
  if (!c) {
    // a retired slot is fine exactly when it duplicates the last card of the sheet
    const chain = decode(info.data.subarray(HEADER + i * CARD, HEADER + (i + 1) * CARD));
    const out = [];
    diff('', chain, fromSheet(sheet[sheet.length - 1]), out);
    if (out.length === 0) {
      console.log(`  slot ${i}: retired (duplicate of ${sheet[sheet.length - 1].id})`);
    } else {
      console.log(`  card ${i}: on chain but not in the sheet (${out.length} fields differ from ${sheet[sheet.length - 1].id})`);
      bad++;
    }
    continue;
  }
  if (i >= count) { console.log(`  ${c.id}: in the sheet but not published`); bad++; continue; }
  const chain = decode(info.data.subarray(HEADER + i * CARD, HEADER + (i + 1) * CARD));
  const out = [];
  diff('', chain, fromSheet(c), out);
  const sol = chain.priceLamports / 1e9;
  const hit = chain.jackpotHitWeight / 2 ** 32;
  console.log(`  ${c.id.padEnd(9)} ${sol.toFixed(4)} SOL  jackpot ${(hit * 100).toFixed(4)}%  ` +
    `per SOL ${(hit / sol * 100).toFixed(3)}%  ${chain.blocks.length} blocks  ` +
    `${chain.pays.length} pays  ${chain.tiers.length} tiers  ${chain.pool.length} pool` +
    (out.length ? `   ${out.length} DIFFER` : ''));
  for (const line of out) console.log(`      ${line}`);
  bad += out.length;
}
console.log(bad === 0 ? '\nchain matches the sheet exactly' : `\n${bad} field(s) differ — republish with: node scripts/setup-devnet.mjs --cards-only${MAINNET ? ' --mainnet' : ''}`);
process.exit(bad === 0 ? 0 : 1);
