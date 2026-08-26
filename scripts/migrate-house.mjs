// One-time: recreate the house ledger so its permission carries the new member set —
// [house, game, admin-as-sponsor] — making the treasury readable by its operator again.
//
//   node scripts/migrate-house.mjs
//
// Order: undelegate → read on basenet → withdraw everything to the admin's ledger → close →
// reopen (the vault now names the rent payer) → settle everything back → delegate. The game
// cannot settle while the house ledger is away, so there is a pause of a minute or two; a
// collect attempted in the window fails cleanly and can be retried.
//
// The jackpot is deliberately not migrated: its ledger having no permission IS the intended
// state — `make_public` semantics, reached early.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import crypto from 'crypto';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { BASENET, TEE, MINTS } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const SOL_MINT = new PublicKey('11111111111111111111111111111111');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const mints = MINTS;
const byAddr = Object.fromEntries(Object.entries(mints).map(([k, v]) => [v, k]));
byAddr[SOL_MINT.toBase58()] = 'SOL';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const anchorDisc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')], PROGRAM);
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const reservePda = () => pda([Buffer.from('vault')], VAULT);
const permPda = (a) => pda([Buffer.from('permission:'), a.toBuffer()], PERMISSION);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });

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

// ── instructions ─────────────────────────────────────────────────────────────

const undelegateIx = () => new TransactionInstruction({
  programId: VAULT,
  keys: [sg(admin.publicKey), rw(ledgerPda(house)), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT)],
  data: anchorDisc('undelegate'),
});

const withdrawHouseIx = (mint, amount) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sg(admin.publicKey), ro(house),
    rw(ledgerPda(house)), rw(ledgerPda(admin.publicKey)), ro(VAULT),
  ],
  data: Buffer.concat([header(17), new PublicKey(mint).toBuffer(), u64(amount)]),
});

const closeLedgerIx = () => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    // the house is writable: the sweep and the rent land on the owner
    sg(admin.publicKey), rw(house), rw(ledgerPda(house)), rw(reservePda()),
    rw(permPda(ledgerPda(house))), ro(PERMISSION), ro(VAULT),
    ro(TOKEN), ro(SystemProgram.programId),
  ],
  data: Buffer.concat([header(18), Buffer.from([0])]),
});

const openLedgerIx = (slots) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sg(admin.publicKey), ro(house), rw(ledgerPda(house)),
    rw(permPda(ledgerPda(house))), ro(PERMISSION), ro(VAULT),
    ro(SystemProgram.programId),
  ],
  data: Buffer.concat([header(15), Buffer.from([0]), u16(slots)]),
});

const settleIx = (mint, amount) => new TransactionInstruction({
  programId: VAULT,
  keys: [
    rw(ledgerPda(admin.publicKey)), rw(ledgerPda(house)),
    sgro(admin.publicKey), ro(house),
  ],
  data: Buffer.concat([anchorDisc('settle'), new PublicKey(mint).toBuffer(), u64(amount)]),
});

/** The public devnet ER; the private TEE is MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo. */
const ER_VALIDATOR = new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');

const delegateHouseIx = () => {
  const ledger = ledgerPda(house);
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sg(admin.publicKey), rw(house),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger), ro(permPda(ledger)),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([header(16), Buffer.from([0]), ER_VALIDATOR.toBuffer()]),
  });
};

const awaitOwner = async (account, want, label) => {
  for (let i = 0; i < 40; i++) {
    const info = await base.getAccountInfo(account);
    if (want === null ? !info : info?.owner.equals(want)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: never reached the expected owner`);
};

// ── the run ──────────────────────────────────────────────────────────────────

const feesBefore = await base.getBalance(admin.publicKey);

// 1 ── bring the house ledger home
const info = await base.getAccountInfo(ledgerPda(house));
if (!info) throw new Error('no house ledger on basenet');
if (info.owner.equals(DELEGATION)) {
  console.log('1. undelegating the house ledger');
  const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
    { commitment: 'confirmed', fetch: fetchRetrying });
  await send(tee, [undelegateIx()], [admin]);
  await awaitOwner(ledgerPda(house), VAULT, 'undelegate');
} else {
  console.log('1. house ledger already at home');
}

// 2 ── what it holds, now readable on basenet. Persisted immediately: if a later step dies,
// the re-run finds the house already empty and must take the refill list from here.
const STATE = 'scripts/.migrate-house-state.json';
const ledgerInfo = await base.getAccountInfo(ledgerPda(house));
const before = ledgerInfo && decodeLedger(ledgerInfo.data);
let holdings;
let slots;
if (before && Object.values(before.balances).some((amt) => amt > 0n)) {
  holdings = Object.entries(before.balances).filter(([, amt]) => amt > 0n)
    .map(([mint, amt]) => [mint, amt.toString()]);
  slots = before.slots;
  fs.writeFileSync(STATE, JSON.stringify({ slots, holdings }, null, 2));
} else if (fs.existsSync(STATE)) {
  ({ slots, holdings } = JSON.parse(fs.readFileSync(STATE, 'utf8')));
  console.log('2. house is empty — resuming from the state file');
} else {
  throw new Error('house ledger is empty and no state file exists — nothing to migrate');
}
console.log(`2. house holds ${holdings.length} balances over ${slots} slots:`);
for (const [mint, amt] of holdings) console.log(`   ${(byAddr[mint] ?? mint).padEnd(7)} ${amt}`);

// 3 ── the admin ledger must exist and be at home to receive them
const adminInfo = await base.getAccountInfo(ledgerPda(admin.publicKey));
if (adminInfo?.owner.equals(DELEGATION)) {
  console.log('3. bringing the admin ledger home');
  const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
    { commitment: 'confirmed', fetch: fetchRetrying });
  await send(tee, [new TransactionInstruction({
    programId: VAULT,
    keys: [sg(admin.publicKey), rw(ledgerPda(admin.publicKey)), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT)],
    data: anchorDisc('undelegate'),
  })], [admin]);
  await awaitOwner(ledgerPda(admin.publicKey), VAULT, 'undelegate admin');
} else if (!adminInfo) {
  console.log('3. opening the admin ledger (zero deposit)');
  const ledger = ledgerPda(admin.publicKey);
  await send(base, [new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(admin.publicKey), rw(ledger), rw(permPda(ledger)), ro(PERMISSION), rw(reservePda()),
      ro(SystemProgram.programId), ro(SystemProgram.programId),
      ro(TOKEN), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('deposit'), SOL_MINT.toBuffer(), u64(0),
                         Buffer.from([0]), Buffer.from([0])]),
  })], [admin]);
} else {
  console.log('3. admin ledger ready');
}

// 4 ── everything out. On a resume, entries already withdrawn are skipped.
console.log('4. withdrawing the house to the admin ledger');
const still = before?.balances ?? {};
for (const [mint, amt] of holdings) {
  const have = still[mint] ?? 0n;
  if (have === 0n) { console.log(`   already out: ${byAddr[mint] ?? mint}`); continue; }
  await send(base, [withdrawHouseIx(mint, have)], [admin]);
  console.log(`   out: ${have} ${byAddr[mint] ?? mint}`);
}

// 5 ── close, reopen (the reopened permission names the sponsor), refill
if (await base.getAccountInfo(ledgerPda(house))) {
  console.log('5. closing the house ledger');
  await send(base, [closeLedgerIx()], [admin]);
  await awaitOwner(ledgerPda(house), null, 'close');
} else {
  console.log('5. house ledger already closed');
}

console.log(`6. reopening at ${slots} slots`);
await send(base, [openLedgerIx(slots)], [admin]);

console.log('7. settling everything back');
for (const [mint, amt] of holdings) {
  await send(base, [settleIx(mint, amt)], [admin]);
  console.log(`   back: ${amt} ${byAddr[mint] ?? mint}`);
}

// 8 ── hand it back to the validator
console.log('8. delegating the house ledger');
await send(base, [delegateHouseIx()], [admin]);
await awaitOwner(ledgerPda(house), DELEGATION, 'delegate');

// 9 ── the point of it all: the operator can read the treasury again
const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
  { commitment: 'confirmed', fetch: fetchRetrying });
let visible = null;
for (let i = 0; i < 40 && !visible; i++) {
  visible = await tee.getAccountInfo(ledgerPda(house));
  if (!visible) await new Promise((r) => setTimeout(r, 1500));
}
if (!visible) throw new Error('house ledger never became readable on the rollup');
const after = decodeLedger(visible.data);
console.log('\nhouse ledger, read from the rollup with the admin token:');
console.log(`   SOL ${after.sol}`);
for (const [mint, amt] of Object.entries(after.balances)) {
  if (mint !== SOL_MINT.toBase58()) console.log(`   ${(byAddr[mint] ?? mint).padEnd(7)} ${amt}`);
}

const feesAfter = await base.getBalance(admin.publicKey);
console.log(`\nthis run cost ${((feesBefore - feesAfter) / 1e9).toFixed(6)} SOL in fees and rent deltas`);
