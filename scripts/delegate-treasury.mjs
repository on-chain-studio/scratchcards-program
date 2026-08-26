// Hands a treasury PDA itself — not its ledger — to a rollup validator.
//
//   node scripts/delegate-treasury.mjs house [validator]     default: the public devnet ER
//
// Only the house needs this. It is the payer inside the rollup: it sponsors each card's
// ephemeral account and the receipts, and pays the VRF, and a lamport debit there only works
// on a delegated account. The jackpot PDA is never debited — it only names its ledger in a
// settle, where it goes in readonly — so it stays on basenet.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { MAGIC_RPC as RPC } from './net.mjs';

const PROGRAM_ID = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(RPC, 'confirmed');

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** The public devnet ER; the private TEE is MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo. */
const ER_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const validator = process.argv[3] ? new PublicKey(process.argv[3]) : ER_VALIDATOR;

/** Delegate (2) — the seeds travel in the payload so the program can sign for the PDA. */
function delegateIx(account, seeds) {
  const at = (prefix, prog) =>
    PublicKey.findProgramAddressSync([Buffer.from(prefix), account.toBuffer()], prog)[0];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      sg(admin.publicKey), rw(account), ro(PROGRAM_ID),
      rw(at('buffer', PROGRAM_ID)), rw(at('delegation', DELEGATION)),
      rw(at('delegation-metadata', DELEGATION)),
      ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([
      header(2), u32(seeds.length),
      ...seeds.map((s) => Buffer.concat([u32(s.length), s])),
      validator.toBuffer(),
    ]),
  });
}

const name = process.argv[2];
if (!name) {
  console.log('usage: node scripts/delegate-treasury.mjs <house>');
  process.exit(1);
}

const seed = Buffer.from(name);
const treasury = PublicKey.findProgramAddressSync([seed], PROGRAM_ID)[0];
const before = await conn.getAccountInfo(treasury);
console.log(`${name}  ${treasury.toBase58()}  owner ${before?.owner.toBase58() ?? 'missing'}`);
console.log(`validator ${validator.toBase58()}`);

if (before?.owner.equals(DELEGATION)) {
  console.log('  ▫ already delegated');
} else {
  const sig = await sendAndConfirmTransaction(
    conn, new Transaction().add(delegateIx(treasury, [seed])), [admin], { commitment: 'confirmed' },
  );
  console.log(`  ${sig}`);
  const after = await conn.getAccountInfo(treasury);
  console.log(after?.owner.equals(DELEGATION) ? '  ✅ delegated' : `  ❌ owner ${after?.owner.toBase58()}`);
}
