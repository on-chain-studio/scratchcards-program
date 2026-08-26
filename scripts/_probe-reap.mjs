// Does the reap crank fire? Create a receipt WITHOUT settling it (so nothing cancels the crank),
// then watch it get closed on its own a tick or two later.
//
//   node scripts/_probe-reap.mjs

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')], PROGRAM);
const config = pda([Buffer.from('config')], PROGRAM);
const jackpot = pda([Buffer.from('jackpot')], PROGRAM);
const houseLedger = pda([Buffer.from('ledger'), house.toBuffer()], VAULT);
const user = admin.publicKey;
const receipt = pda([Buffer.from('receipt'), PROGRAM.toBuffer(), user.toBuffer()], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const conn = new Connection(`https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');
console.log('receipt', receipt.toBase58());

const purchase = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sgro(user), ro(user), ro(config), rw(house), rw(receipt),
    rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT), ro(jackpot),
    rw(houseLedger), rw(MAGIC_CONTEXT),
  ],
  data: Buffer.concat([header(24), u64(0)]), // RequestPurchase, card 0
});

const state = async () => {
  const i = await conn.getAccountInfo(receipt);
  return i ? `PRESENT (${i.data.length} B, owner ${i.owner.toBase58().slice(0, 8)}…)` : 'ABSENT';
};

try {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(purchase),
    [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log(`✅ request_purchase (no settle) landed ${sig}`);
} catch (e) {
  console.log('❌ create failed —', String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0]);
  process.exit(1);
}

console.log('immediately after:', await state());
for (let i = 1; i <= 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await state();
  console.log(`  +${i * 2}s:`, s);
  if (s === 'ABSENT') { console.log('\n🎉 the crank reaped the abandoned receipt'); process.exit(0); }
}
console.log('\n⚠️  receipt still present after 30s — crank did not fire (or not yet)');
process.exit(0);
