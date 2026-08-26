// Is a same-tx create+close of an ephemeral receipt rent-NEUTRAL for the sponsor? If yes, the
// sponsor never needs a standing float — only a transient balance during the tx — and an
// un-closed (abandoned) receipt is the only thing that actually holds rent.
//
//   node scripts/_probe-receipt-rent.mjs                    full: create + close in one tx
//   node scripts/_probe-receipt-rent.mjs --leak             create-only: leaves a receipt (the bug)
//
// Measures the HOUSE PDA's raw lamports (its ER-side rent balance) before/after, unlike
// _probe-receipt.mjs which watches the vault ledger movement.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')]);
const user = admin.publicKey;
const ledger = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const receipt = pda([Buffer.from('receipt'), house.toBuffer(), user.toBuffer()], VAULT);
const card = pda([Buffer.from('card'), user.toBuffer()]);
const vaultAuthority = pda([], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

const LEAK = process.argv.includes('--leak');
const endpoint = 'https://devnet-tee.magicblock.app';
const conn = new Connection(`${endpoint}?token=${await teeToken(admin)}`, 'confirmed');
console.log('endpoint', endpoint, LEAK ? '(create-only — leaves a receipt)' : '(create + close, one tx)', '\n');

const lamps = async (k) => (await conn.getAccountInfo(k))?.lamports ?? null;
const showReceipt = async () => {
  const i = await conn.getAccountInfo(receipt);
  console.log(`   receipt: ${i ? `PRESENT — ${i.data.length} B, ${i.lamports} lamports, owner ${i.owner.toBase58().slice(0, 8)}…` : 'ABSENT'}`);
};

const probeIx = new TransactionInstruction({
  programId: PROGRAM,
  keys: [sgro(user), ro(user), rw(house), rw(receipt), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT)],
  data: header(5),
});
const settleIx = new TransactionInstruction({
  programId: VAULT,
  keys: [
    rw(receipt), ro(house), sgro(user), ro(PROGRAM), ro(vaultAuthority),
    rw(ledger(user)), rw(ledger(house)),
    rw(house), rw(card), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM),
  ],
  data: disc('settle_receipt'),
});

const houseBefore = await lamps(house);
console.log('house PDA lamports before:', houseBefore);
await showReceipt();

try {
  const ixs = LEAK ? [probeIx] : [probeIx, settleIx];
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs),
    [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log(`\n✅ LANDED ${sig}`);
} catch (e) {
  console.log('\n❌ FAILED —', String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0]);
  process.exit(1);
}

const houseAfter = await lamps(house);
console.log('\nhouse PDA lamports after: ', houseAfter);
console.log('   net change:', houseAfter - houseBefore, 'lamports', LEAK ? '(rent a live receipt holds)' : '(≈0 ⇒ create+close is rent-neutral)');
await showReceipt();
process.exit(0);
