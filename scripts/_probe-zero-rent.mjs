// Does the ER let you make a data-carrying account with ZERO lamports — and does it purge
// itself at end-of-transaction? That's the whole bet behind self-cleaning receipts: a receipt
// that only ever lives inside one tx needs no rent, and a create-without-close leaves nothing.
//
//   node scripts/_probe-zero-rent.mjs                     the private TEE (default)
//   node scripts/_probe-zero-rent.mjs https://an-er       somewhere else
//
// Three probes, each on a fresh throwaway key (nothing to clean up — 0-lamport accounts vanish):
//   1. allocate(space) at 0 lamports, alone            → does it land? does the account persist?
//   2. allocate(space) + assign(to a program) at 0 lamports, one tx, then read it back
//   3. same as 1 but paying rent-exempt lamports        → the control: this we know persists

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const SPACE = 311;                       // a purchase receipt's size
const DEFAULT_ER = 'https://devnet-tee.magicblock.app';
const arg = process.argv[2]?.startsWith('http') ? process.argv[2] : null;
const endpoint = arg ?? DEFAULT_ER;
const usingTee = endpoint.includes('devnet-tee');
const conn = new Connection(
  usingTee ? `${endpoint}?token=${await teeToken(admin)}` : endpoint, 'confirmed');
console.log('endpoint', endpoint, '\n');

const logsBySig = new Map();
try { await conn.onLogs('all', (l) => logsBySig.set(l.signature, l.logs ?? []), 'confirmed'); } catch {}

const send = async (label, ixs, signers) => {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs),
      signers, { commitment: 'confirmed', skipPreflight: true });
    console.log(`✅ ${label} — LANDED ${sig}`);
    return sig;
  } catch (e) {
    const status = String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0];
    console.log(`❌ ${label} — ${status}`);
    const sig = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{60,}) /)?.[1];
    await new Promise((r) => setTimeout(r, 2000));
    for (const l of (sig && logsBySig.get(sig)) ?? []) console.log('     ', l);
    return null;
  }
};

const report = async (label, key) => {
  const i = await conn.getAccountInfo(key);
  console.log(`   ${label}: ${i ? `PRESENT — ${i.data.length} B, ${i.lamports} lamports, owner ${i.owner.toBase58().slice(0, 8)}…` : 'ABSENT (purged)'}`);
};

// 1. allocate at zero lamports, alone
{
  const a = Keypair.generate();
  console.log('probe 1 — allocate', SPACE, 'B at 0 lamports, alone');
  await send('allocate(0 lamports)', [
    SystemProgram.allocate({ accountPubkey: a.publicKey, space: SPACE }),
  ], [admin, a]);
  await report('after', a.publicKey);
  console.log();
}

// 2. allocate + assign to a program, one tx (a data account a program could then write/close)
{
  const a = Keypair.generate();
  console.log('probe 2 — allocate + assign at 0 lamports, one tx');
  await send('allocate+assign(0 lamports)', [
    SystemProgram.allocate({ accountPubkey: a.publicKey, space: SPACE }),
    SystemProgram.assign({ accountPubkey: a.publicKey, programId: SystemProgram.programId }),
  ], [admin, a]);
  await report('after', a.publicKey);
  console.log();
}

// 3. control: pay the rent-exempt minimum — this one should persist
{
  const a = Keypair.generate();
  const lamports = await conn.getMinimumBalanceForRentExemption(SPACE);
  console.log('probe 3 — control: createAccount paying', lamports, 'lamports (rent-exempt)');
  await send('createAccount(rent-exempt)', [
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey, newAccountPubkey: a.publicKey,
      lamports, space: SPACE, programId: SystemProgram.programId,
    }),
  ], [admin, a]);
  await report('after', a.publicKey);
  // clean up the control so it leaves nothing: sweep its lamports back to admin
  if (await conn.getAccountInfo(a.publicKey)) {
    await send('  cleanup: close control', [
      SystemProgram.transfer({ fromPubkey: a.publicKey, toPubkey: admin.publicKey, lamports }),
    ], [admin, a]).catch(() => {});
  }
}

process.exit(0);
