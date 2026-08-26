// Rewrites each card's jackpot hit chance to 1000 bp per SOL of price, touching nothing
// else: every other field is read back from the deployed config and re-sent verbatim.
//
// Why: hitBp was flat-ish while prices span 125×, which made the cheapest card a 25×
// more efficient jackpot farm per SOL. Chance must scale with price so every lamport
// buys the same slice of the pot — that is also what makes the sheet's "jackpot take is
// 10% back to players" claim true per card rather than only in aggregate. Token RTP is
// untouched: the jackpot line never pays from the pool (engine sets a flag, nothing else).

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { RPC, PROGRAM_ID, loadCards } from './sheet.mjs';

const BP_PER_SOL = 1000;

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(RPC, 'confirmed');

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const mintOf = (symbol) => symbol === 'SOL'
  ? new PublicKey('11111111111111111111111111111111')
  : new PublicKey(MINTS[symbol]);

const { cards } = await loadCards();
const configPda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0];

for (let i = 0; i < cards.length; i++) {
  const c = cards[i];
  const hitBp = Math.round((c.priceLamports / 1e9) * BP_PER_SOL);
  if ((c.priceLamports / 1e9) * BP_PER_SOL !== hitBp) {
    throw new Error(`card ${i}: price ${c.priceLamports} does not land on a whole bp at ${BP_PER_SOL}/SOL`);
  }
  if (hitBp === c.hitBp) { console.log(`card ${i}: already ${hitBp} bp`); continue; }

  const parts = [
    header(9), Buffer.from([i, c.kind]), u64(c.priceLamports),
    u16(c.winBp), u16(c.nearBp), u16(hitBp), u16(c.multBp),
    u32(c.pool.length),
  ];
  for (const p of c.pool) {
    parts.push(mintOf(p.symbol).toBuffer(), u16(p.weight), u64(p.amount), u64(0), u64(0));
  }
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      // SetCard buys shelf room as it needs it, so it may pay rent into the config.
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat(parts),
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin]);
  console.log(`card ${i}: hitBp ${c.hitBp} -> ${hitBp}  ${sig}`);
}

const after = (await loadCards()).cards;
console.log('\ncard | price SOL | hitBp | chance per SOL');
after.forEach((c, i) => {
  const sol = c.priceLamports / 1e9;
  console.log(i, '|', sol.toFixed(4), '|', c.hitBp, '|', (c.hitBp / sol).toFixed(0));
});
