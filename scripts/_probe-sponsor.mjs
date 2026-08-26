// Can the house LEDGER (a data-carrying, vault-owned, delegated PDA) sponsor an ephemeral
// account? Calls the vault's temporary PROBE_SPONSOR ix, which creates + closes a throwaway
// ephemeral sponsored by the ledger in one instruction and logs the ledger's account lamports
// at each step.
//
//   node scripts/_probe-sponsor.mjs

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')], PROGRAM);
const ledger = pda([Buffer.from('ledger'), house.toBuffer()], VAULT);
const probe = pda([Buffer.from('probe'), ledger.toBuffer()], VAULT);

const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });

const endpoint = 'https://devnet-tee.magicblock.app';
const conn = new Connection(`${endpoint}?token=${await teeToken(admin)}`, 'confirmed');
console.log('endpoint', endpoint);
console.log('house   ', house.toBase58());
console.log('ledger  ', ledger.toBase58());
console.log('probe   ', probe.toBase58(), '\n');

const li = await conn.getAccountInfo(ledger);
console.log('ledger account:', li ? `${li.data.length} B, ${li.lamports} lamports, owner ${li.owner.toBase58().slice(0, 8)}…` : 'ABSENT');

const logsBySig = new Map();
try { await conn.onLogs(VAULT, (l) => logsBySig.set(l.signature, l.logs ?? []), 'confirmed'); } catch {}

const ix = new TransactionInstruction({
  programId: VAULT,
  keys: [rw(ledger), rw(probe), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM)],
  data: Buffer.from([238, 1, 2, 3, 4, 5, 6, 7]),
});

try {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix),
    [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log(`\n✅ LANDED ${sig}\n`);
  await new Promise((r) => setTimeout(r, 2000));
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  for (const l of tx?.meta?.logMessages ?? logsBySig.get(sig) ?? []) {
    if (l.includes('PROBE') || l.includes('Program log')) console.log('  ', l);
  }
} catch (e) {
  console.log('\n❌ FAILED —', String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0]);
  const sig = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{60,}) /)?.[1];
  await new Promise((r) => setTimeout(r, 2500));
  for (const l of (sig && logsBySig.get(sig)) ?? ['(no logs)']) console.log('  ', l);
}
process.exit(0);
