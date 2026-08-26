// Hands the house and jackpot *ledgers* to a rollup validator. Both sides of a settle must be
// on the same validator, so nothing can be bought or collected until this has run.
//
//   node scripts/delegate-ledgers.mjs [validator]     default: the public devnet ER
//
// Needed after anything that brings them home — a ledger migration, or an undelegate sweep.
// The house *PDA* is delegated separately by delegate-treasury.mjs and is not touched here.

import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { MAGIC_RPC as RPC, ADMIN_PATH } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

/** The public devnet ER; the private TEE is MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo. */
const ER_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const validator = process.argv[2] ? new PublicKey(process.argv[2]) : ER_VALIDATOR;

const KEYPAIR = process.env.VAULT_KEYPAIR || ADMIN_PATH;
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(KEYPAIR))));
const conn = new Connection(RPC, 'confirmed');

const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const treasury = (seed) => pda([Buffer.from(seed)], PROGRAM);
const ledgerPda = (owner) => pda([Buffer.from('ledger'), owner.toBuffer()], VAULT);

const delegateIx = (which, seed) => {
  const t = treasury(seed);
  const ledger = ledgerPda(t);
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sg(admin.publicKey), rw(t),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([header(16), Buffer.from([which]), validator.toBuffer()]),
  });
};

console.log(`validator ${validator.toBase58()}\n`);

for (const [which, seed] of [[0, 'house'], [1, 'jackpot']]) {
  const ledger = ledgerPda(treasury(seed));
  const info = await conn.getAccountInfo(ledger);
  if (info?.owner.equals(DELEGATION)) { console.log(`  ⏭  ${seed} ledger already delegated`); continue; }
  try {
    const sig = await sendAndConfirmTransaction(
      conn, new Transaction().add(delegateIx(which, seed)), [admin], { commitment: 'confirmed' },
    );
    const now = await conn.getAccountInfo(ledger);
    console.log(`  ${now?.owner.equals(DELEGATION) ? '✅' : '⚠️ '} ${seed} ledger  ${sig.slice(0, 16)}…`);
  } catch (e) {
    console.log(`  ❌ ${seed}  ${String(e).split('\n')[0]}`);
    for (const l of (e?.transactionLogs || e?.logs || []).slice(-8)) console.log('       ', l);
  }
}
