// Drops a treasury ledger's permission, making it readable on the rollup.
//
//   node scripts/close-permission.mjs jackpot
//
// The jackpot runs without one on purpose: the pot is the draw, so anyone should be able to
// read it. The ledger does not have to come home first — a permission is a basenet account and
// closing it never touches ledger state.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { MAGIC_RPC as RPC } from './net.mjs';

const PROGRAM_ID = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT_PROGRAM = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION_PROGRAM = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

/// Index into the program's TREASURIES.
const TREASURIES = ['house', 'jackpot'];

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(RPC, 'confirmed');

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
/// The dispatcher reads an 8-byte header and hands the rest to the instruction.
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const treasuryPda = (seed) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed)], PROGRAM_ID)[0];
const ledgerPda = (owner) =>
  PublicKey.findProgramAddressSync([Buffer.from('ledger'), owner.toBuffer()], VAULT_PROGRAM)[0];
const permissionPda = (account) =>
  PublicKey.findProgramAddressSync([Buffer.from('permission:'), account.toBuffer()], PERMISSION_PROGRAM)[0];

async function main() {
  const name = process.argv[2];
  const which = TREASURIES.indexOf(name);
  if (which < 0) {
    console.log(`usage: node scripts/close-permission.mjs <${TREASURIES.join('|')}>`);
    process.exit(1);
  }

  const treasury = treasuryPda(name);
  const ledger = ledgerPda(treasury);
  const permission = permissionPda(ledger);

  const before = await conn.getAccountInfo(permission);
  if (!before) {
    console.log(`▫ ${name} already has no permission (${permission.toBase58()})`);
    return;
  }
  console.log(`${name} ledger      ${ledger.toBase58()}`);
  console.log(`${name} permission  ${permission.toBase58()}  ${before.data.length} bytes`);

  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        sg(admin.publicKey), ro(treasury), ro(ledger), rw(permission),
        ro(PERMISSION_PROGRAM), ro(VAULT_PROGRAM), ro(SYSTEM_PROGRAM),
      ],
      data: Buffer.concat([header(20), Buffer.from([which])]),
    })),
    [admin], { commitment: 'confirmed' },
  );
  console.log(`  ${sig}`);

  const after = await conn.getAccountInfo(permission);
  console.log(after ? `  ❌ still there (${after.data.length} bytes)` : '  ✅ closed');
}

main().catch((e) => {
  console.error(String(e).split('\n')[0]);
  for (const l of (e?.transactionLogs || e?.logs || []).slice(-8)) console.error('   ', l);
  process.exit(1);
});
