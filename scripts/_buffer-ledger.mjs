// Puts a small lamport buffer on the house ledger's ACCOUNT (above its rent floor) so an
// abandoned receipt becomes creatable — the only way to exercise the reap crank. Undelegates the
// ledger, transfers 0.01 SOL onto it, re-delegates.
//
//   node scripts/_buffer-ledger.mjs

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const BASENET = 'https://rpc.magicblock.app/devnet';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const TEE_VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const house = pda([Buffer.from('house')], PROGRAM);
const ledger = pda([Buffer.from('ledger'), house.toBuffer()], VAULT);

const base = new Connection(BASENET, 'confirmed');
const tee = new Connection(`https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');

const ownerOf = async (conn, k) => (await conn.getAccountInfo(k))?.owner ?? null;
const wait = async (conn, k, want, label) => {
  for (let i = 0; i < 40; i++) {
    if ((await ownerOf(conn, k))?.equals(want)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  ⚠ ${label}: never reached ${want.toBase58().slice(0, 8)}…`);
  return false;
};

// UndelegateTreasury (30) — game CPI-signs the house seeds as the ledger's owner while the admin
// pays; the house PDA is only a read-only authority. Commits + undelegates the ledger.
const undelegateIx = new TransactionInstruction({
  programId: PROGRAM,
  keys: [sgro(admin.publicKey), ro(house), rw(ledger), ro(VAULT), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT)],
  data: Buffer.concat([header(30), Buffer.from([0])]),
});

// DelegateTreasury (16) — re-delegate the ledger to the TEE.
const delegateIx = (() => {
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sg(admin.publicKey), rw(house),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger), ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([header(16), Buffer.from([0]), TEE_VALIDATOR.toBuffer()]),
  });
})();

console.log('ledger', ledger.toBase58());
console.log('owner now:', (await ownerOf(base, ledger))?.toBase58());

console.log('\n1. undelegate (on the TEE)');
if ((await ownerOf(base, ledger))?.equals(DELEGATION)) {
  await sendAndConfirmTransaction(tee, new Transaction().add(undelegateIx), [admin], { commitment: 'confirmed', skipPreflight: true });
  await wait(base, ledger, VAULT, 'ledger home');
} else {
  console.log('   already home — skipping');
}
const homeInfo = await base.getAccountInfo(ledger);
console.log('   home, lamports', homeInfo?.lamports);

console.log('\n2. buffer +0.01 SOL onto the ledger account (basenet)');
await sendAndConfirmTransaction(base, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: ledger, lamports: 10_000_000 })), [admin], { commitment: 'confirmed' });
console.log('   lamports now', (await base.getAccountInfo(ledger))?.lamports);

console.log('\n3. re-delegate to the TEE (basenet)');
await sendAndConfirmTransaction(base, new Transaction().add(delegateIx), [admin], { commitment: 'confirmed' });
await wait(base, ledger, DELEGATION, 'ledger delegated');
console.log('   done. ledger buffered + delegated. now run: node scripts/_probe-reap.mjs');
process.exit(0);
