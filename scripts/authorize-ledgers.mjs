// One-time migration: set the house and jackpot vault ledgers' stored member program to the game,
// via the game's temporary AuthorizeTreasury (slot 20) → vault authorize_pda_ledger. Without it,
// the redesigned vault's settle_receipt rejects our treasuries (code 7000 + 300 + index).
//
//   node scripts/authorize-ledgers.mjs
//
// Runs wherever each ledger currently lives: on the ER if delegated, on basenet if home. Remove
// the game's AuthorizeTreasury and the vault's authorize_pda_ledger once both are done.

import fs from 'fs';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { BASENET, TEE, ADMIN_PATH } from './net.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });

const fetchRetrying = async (url, opts) => {
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, opts);
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return fetch(url, opts);
};
const base = new Connection(BASENET, { commitment: 'confirmed', fetch: fetchRetrying });
const send = (conn, ixs, signers) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers,
    { commitment: 'confirmed', skipPreflight: conn !== base });

const AUTHORIZE_TREASURY = 20;
const treasuries = [
  { which: 0, name: 'house', pda: pda([Buffer.from('house')], PROGRAM) },
  { which: 1, name: 'jackpot', pda: pda([Buffer.from('jackpot')], PROGRAM) },
];

const authorizeIx = (which, treasury) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), ro(treasury), rw(ledgerPda(treasury)), ro(VAULT)],
  data: Buffer.concat([header(AUTHORIZE_TREASURY), Buffer.from([which])]),
});

for (const t of treasuries) {
  const ledger = ledgerPda(t.pda);
  const info = await base.getAccountInfo(ledger);
  if (!info) { console.log(`${t.name}: no ledger on basenet — skipping`); continue; }
  const delegated = info.owner.equals(DELEGATION);
  const where = delegated ? 'ER' : 'basenet';
  const conn = delegated
    ? new Connection(`${TEE}?token=${await teeToken(admin)}`, { commitment: 'confirmed', fetch: fetchRetrying })
    : base;
  console.log(`${t.name}: authorizing on ${where} (ledger ${ledger.toBase58()})`);
  const sig = await send(conn, [authorizeIx(t.which, t.pda)], [admin]);
  console.log(`  ok ${sig}`);
}
console.log('done');
