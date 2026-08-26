// Initialize the scratch app against the vault. Ordered + idempotent — safe to re-run.
//
//   node scripts/setup-scratch.mjs
//
// Order matters: make_public needs the jackpot ledger at home, so it runs BEFORE delegation.
// The house-ledger float and card shelf are separate jobs — top-up.mjs and set_card/setup-devnet.
//
// Steps: Initialize (config + house/jackpot PDAs) → open house + jackpot ledgers → make the jackpot
// ledger public → fund the house PDA (card ephemeral rent) → delegate the house PDA and both ledgers.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { BASENET } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const SYSTEM = SystemProgram.programId;
const VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'); // the TEE

// ── tunables ──
const CARD_COUNT = 0;                           // fresh shelf; cards are published by set_card separately
const HOUSE_PDA_FUND = 0.1 * LAMPORTS_PER_SOL;  // lamports on ["house"] to sponsor card ephemeral rent
const HOUSE_SLOTS = 20, JACKPOT_SLOTS = 4;

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');

const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const config = pda([Buffer.from('config')], PROGRAM);
const house = pda([Buffer.from('house')], PROGRAM);
const jackpot = pda([Buffer.from('jackpot')], PROGRAM);
const analytics = pda([Buffer.from('analytics')], PROGRAM);
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const permPda = (a) => pda([Buffer.from('permission:'), a.toBuffer()], PERMISSION);
const dpda = (tag, acct, prog) => pda([Buffer.from(tag), acct.toBuffer()], prog);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const send = (ixs) => sendAndConfirmTransaction(base, new Transaction().add(...ixs), [admin], { commitment: 'confirmed' });
const info = (k) => base.getAccountInfo(k);
const ownerIs = async (k, p) => (await info(k))?.owner.equals(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const awaitDelegated = async (k) => { for (let i = 0; i < 40; i++) { if (await ownerIs(k, DELEGATION)) return true; await sleep(1500); } return false; };

// ── instructions ──
const initializeIx = () => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), rw(config), rw(house), rw(jackpot),
         rw(analytics), rw(permPda(analytics)), ro(PERMISSION), ro(SYSTEM)],
  data: Buffer.concat([header(1), Buffer.from([CARD_COUNT])]),
});
const openLedgerIx = (which, treasury) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), ro(treasury), rw(ledgerPda(treasury)), rw(permPda(ledgerPda(treasury))),
         ro(PERMISSION), ro(VAULT), ro(SYSTEM)],
  data: Buffer.concat([header(15), Buffer.from([which]), u16(which === 0 ? HOUSE_SLOTS : JACKPOT_SLOTS)]),
});
const makePublicIx = (which, treasury) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), ro(treasury), ro(ledgerPda(treasury)), rw(permPda(ledgerPda(treasury))),
         ro(PERMISSION), ro(VAULT), ro(SYSTEM)],
  data: Buffer.concat([header(22), Buffer.from([which]), Buffer.from([1])]),
});
const delegateLedgerIx = (which, treasury) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), rw(treasury),
         rw(dpda('buffer', ledgerPda(treasury), VAULT)), rw(dpda('delegation', ledgerPda(treasury), DELEGATION)),
         rw(dpda('delegation-metadata', ledgerPda(treasury), DELEGATION)), rw(ledgerPda(treasury)),
         ro(VAULT), ro(DELEGATION), ro(SYSTEM)],
  data: Buffer.concat([header(16), Buffer.from([which]), VALIDATOR.toBuffer()]),
});
const delegatePdaIx = (seedStr, account) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), rw(account), ro(PROGRAM),
         rw(dpda('buffer', account, PROGRAM)), rw(dpda('delegation', account, DELEGATION)),
         rw(dpda('delegation-metadata', account, DELEGATION)), ro(DELEGATION), ro(SYSTEM)],
  data: Buffer.concat([header(2), u32(1), u32(seedStr.length), Buffer.from(seedStr), VALIDATOR.toBuffer()]),
});

// ── run ──
// Two transactions, not eight: everything that creates or configures rides one, every
// delegation the other. Instructions execute in order within a transaction, so a ledger
// opened by instruction n is home for the make-public at n+1 — and a partial setup either
// lands whole or not at all.
console.log('1. create + configure');
const setupIxs = [];
if (await info(config) && await info(analytics)) console.log('   ⏭  config + analytics exist');
else { setupIxs.push(initializeIx()); console.log('   • initialize (config + house/jackpot/analytics)'); }

for (const [name, which, t] of [['house', 0, house], ['jackpot', 1, jackpot]]) {
  if (await info(ledgerPda(t))) { console.log(`   ⏭  ${name} ledger exists`); continue; }
  setupIxs.push(openLedgerIx(which, t));
  console.log(`   • open ${name} ledger ${ledgerPda(t).toBase58()}`);
}

const jackpotLedgerNew = !(await info(ledgerPda(jackpot)));
if (jackpotLedgerNew) { setupIxs.push(makePublicIx(1, jackpot)); console.log('   • make jackpot public'); }
else if (!(await info(permPda(ledgerPda(jackpot))))) console.log('   ⏭  jackpot already public');
else if (await ownerIs(ledgerPda(jackpot), DELEGATION)) console.log('   ⚠️  jackpot ledger delegated — undelegate it first, then re-run');
else { setupIxs.push(makePublicIx(1, jackpot)); console.log('   • make jackpot public'); }

const hb = (await info(house))?.lamports ?? 0;
if (await ownerIs(house, DELEGATION)) console.log(`   ⏭  house PDA delegated (${(hb / 1e9).toFixed(3)} SOL) — fund on the ER if it needs more`);
else if (hb >= HOUSE_PDA_FUND) console.log(`   ⏭  house PDA already holds ${(hb / 1e9).toFixed(3)} SOL`);
else {
  setupIxs.push(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: house, lamports: HOUSE_PDA_FUND - hb }));
  console.log('   • fund the house PDA (card rent)');
}

if (setupIxs.length) { await send(setupIxs); console.log(`   ✅ ${setupIxs.length} instruction(s), one transaction`); }

console.log('2. delegate');
const targets = [
  ['house PDA', delegatePdaIx('house', house), house],
  ['analytics PDA', delegatePdaIx('analytics', analytics), analytics],
  ['house ledger', delegateLedgerIx(0, house), ledgerPda(house)],
  ['jackpot ledger', delegateLedgerIx(1, jackpot), ledgerPda(jackpot)],
];
const delIxs = [];
for (const [name, ix, key] of targets) {
  if (await ownerIs(key, DELEGATION)) { console.log(`   ⏭  ${name} already delegated`); continue; }
  delIxs.push([name, ix, key]);
  console.log(`   • ${name}`);
}
if (delIxs.length) {
  await send(delIxs.map(([, ix]) => ix));
  for (const [name, , key] of delIxs) {
    console.log(`   ${await awaitDelegated(key) ? '✅' : '⚠️ '} ${name}`);
  }
}
console.log('\ndone. (house-ledger float: run top-up.mjs; card shelf: set_card / setup-devnet)');
