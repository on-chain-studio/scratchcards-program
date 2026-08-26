// The buy flow with everything but the receipt removed.
//
//   node scripts/_probe-receipt.mjs                          the endpoint the ledgers are on
//   node scripts/_probe-receipt.mjs https://an-er.example     somewhere else
//   node scripts/_probe-receipt.mjs <url> --create-only       skip the settle
//
// ProbeReceipt (30) writes a receipt for 0.0001 SOL with the no-op as its callback, then
// settle_receipt moves it and calls back. Same two-instruction shape as a purchase, same
// account metas, minus the card, the VRF, the config lookup and the jackpot.
//
// --create-only is for a validator the ledgers are not delegated to, where the settle cannot
// run: it still answers whether a receipt can be created there at all.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { decodeLedger } from './accounts.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
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
/** The vault's seedless authority — it signs the callback as proof of payment. */
const vaultAuthority = pda([], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

/** Where the ledgers are delegated. The private TEE is https://devnet-tee.magicblock.app. */
const DEFAULT_ER = 'https://devnet.magicblock.app';

const arg = process.argv[2]?.startsWith('http') ? process.argv[2] : null;
const CREATE_ONLY = process.argv.includes('--create-only');
const endpoint = arg ?? DEFAULT_ER;
const usingTee = endpoint.includes('devnet-tee');
const tee = new Connection(
  usingTee ? `${endpoint}?token=${await teeToken(admin)}` : endpoint, 'confirmed');
console.log('endpoint', endpoint, CREATE_ONLY ? '(create only)' : '(create + settle)');
const logsBySig = new Map();
try {
  await tee.onLogs('all', (l) => logsBySig.set(l.signature, l.logs ?? []), 'confirmed');
} catch { /* logs are a bonus */ }

const solOf = async (owner) => {
  const i = await tee.getAccountInfo(ledger(owner));
  return i ? Number(decodeLedger(i.data).sol) : null;
};

const probeIx = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sgro(user), ro(user), rw(house), rw(receipt),
    rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT),
  ],
  data: header(5),
});

const settleIx = new TransactionInstruction({
  programId: VAULT,
  keys: [
    rw(receipt), ro(house), sgro(user), ro(PROGRAM), ro(vaultAuthority),
    // the receipt's ledgers, in index order, then what ProbeResolve needs
    rw(ledger(user)), rw(ledger(house)),
    rw(house), rw(card), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM),
  ],
  data: disc('settle_receipt'),
});

console.log('receipt', receipt.toBase58());
const before = CREATE_ONLY ? null : await solOf(user);
if (!CREATE_ONLY) {
  console.log('player ledger before', before !== null ? (before / 1e9).toFixed(6) : 'absent');
  console.log('house ledger before ', ((await solOf(house)) / 1e9).toFixed(6));
}

try {
  const ixs = CREATE_ONLY ? [probeIx] : [probeIx, settleIx];
  const sig = await sendAndConfirmTransaction(tee, new Transaction().add(...ixs),
    [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log(`✅ LANDED ${sig}`);
  const i = await tee.getAccountInfo(receipt);
  console.log(`   receipt now: ${i ? `${i.data.length} B, owner ${i.owner.toBase58()}` : 'absent'}`);
  const c = await tee.getAccountInfo(card);
  console.log(`   card now   : ${c ? `${c.data.length} B, owner ${c.owner.toBase58()}` : 'absent'}`);
  if (!CREATE_ONLY) {
    const after = await solOf(user);
    console.log(`   player ledger after  ${(after / 1e9).toFixed(6)}  (moved ${((before - after) / 1e9).toFixed(6)})`);
    console.log(`   house ledger after   ${((await solOf(house)) / 1e9).toFixed(6)}`);
  }
} catch (e) {
  console.log('❌ FAILED —', String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0]);
  const sig = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{60,}) /)?.[1];
  await new Promise((r) => setTimeout(r, 2500));
  for (const l of (sig && logsBySig.get(sig)) ?? ['(no logs — failed before execution)']) {
    console.log('   ', l);
  }
}
process.exit(0);
