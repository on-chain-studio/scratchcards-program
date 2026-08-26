// Moves the game between rollup validators.
//
//   node scripts/move-validator.mjs tee             move everything to the private TEE
//   node scripts/move-validator.mjs er              move everything to the public ER
//   node scripts/move-validator.mjs tee --undelegate    bring everything home and stop
//
// What moves: the dev, house and jackpot *ledgers*, plus the house and analytics *PDAs*. The jackpot PDA is
// never delegated — it only ever goes into a settle readonly — so it is left alone.
//
// Undelegation is initiated on the validator that currently holds the account, so each one is
// sent to whichever rollup its delegation record names rather than to an assumed endpoint. It
// lands on basenet a few slots later, so every step waits for the owner to come back.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { BASENET, TEE, PUBLIC_ER } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
// The magic program's ephemeral vault funds the commit; the rollup special-cases it as writable.
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

/** The two rollups, by validator identity. `private` decides whether reaching it needs a token. */
const ROLLUPS = {
  tee: { validator: new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'), url: TEE, private: true },
  er:  { validator: new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'), url: PUBLIC_ER, private: false },
};

const target = ROLLUPS[process.argv[2]];
if (!target) {
  console.log('usage: node scripts/move-validator.mjs <tee|er> [--undelegate]');
  process.exit(1);
}
const ER_VALIDATOR = target.validator;
const UNDELEGATE_ONLY = process.argv.includes('--undelegate');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const base = new Connection(BASENET, 'confirmed');

/** A connection to whichever rollup holds an account now — undelegation has to be sent there. */
const conns = new Map();
const rollupFor = async (validator) => {
  const entry = Object.values(ROLLUPS).find((r) => r.validator.equals(validator));
  if (!entry) throw new Error(`unknown validator ${validator.toBase58()}`);
  if (!conns.has(entry.url)) {
    const url = entry.private ? `${entry.url}?token=${await teeToken(admin)}` : entry.url;
    conns.set(entry.url, new Connection(url, 'confirmed'));
  }
  return conns.get(entry.url);
};

const pda = (s, p = PROGRAM) => PublicKey.findProgramAddressSync(s, p)[0];
const house = pda([Buffer.from('house')]);
const jackpot = pda([Buffer.from('jackpot')]);
const analytics = pda([Buffer.from('analytics')]);
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const anchorDisc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

const send = (conn, ixs, signers) => sendAndConfirmTransaction(
  conn, new Transaction().add(...ixs), signers,
  { commitment: 'confirmed', skipPreflight: conn !== base });

/** vault::undelegate — a wallet's own ledger (the dev ledger). The wallet is both the fee payer
 *  and the ledger's owner, so it fills the payer and authority slots alike. */
const undelegateWalletLedgerIx = (owner) => new TransactionInstruction({
  programId: VAULT,
  keys: [
    sg(admin.publicKey), sgro(admin.publicKey), rw(ledgerPda(owner)),
    ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT),
  ],
  data: anchorDisc('undelegate'),
});

/** UndelegateTreasury (30) — a treasury ledger; the game CPI-signs the treasury seeds as the
 *  ledger's owner while the admin pays. The treasury is only a read-only authority. */
const undelegateTreasuryIx = (which, treasury) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sgro(admin.publicKey), ro(treasury), rw(ledgerPda(treasury)),
    ro(VAULT), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT),
  ],
  data: Buffer.concat([header(30), Buffer.from([which])]),
});

/** RequestUndelegation (4) — same, for one of the game's own PDAs. The admin pays. */
const undelegatePdaIx = (account) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(admin.publicKey), rw(account), rw(MAGIC_CONTEXT), ro(MAGIC_PROGRAM), rw(EPHEMERAL_VAULT)],
  data: header(4),
});

/** DelegateHouse (16) — a treasury ledger, with the validator named. */
const delegateLedgerIx = (which, treasury) => {
  const ledger = ledgerPda(treasury);
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sg(admin.publicKey), rw(treasury),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([header(16), Buffer.from([which]), ER_VALIDATOR.toBuffer()]),
  });
};

/** vault::delegate_ledger — a wallet's own ledger; the owner signs. */
const delegateWalletLedgerIx = (owner) => {
  const ledger = ledgerPda(owner);
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(admin.publicKey), { pubkey: owner, isSigner: true, isWritable: false },
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('delegate_ledger'), Buffer.from([1]), ER_VALIDATOR.toBuffer()]),
  });
};

/** Delegate (2) — one of the game's own PDAs, with the validator named. */
const delegatePdaIx = (account, seeds) => {
  const at = (prefix, prog) => pda([Buffer.from(prefix), account.toBuffer()], prog);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sg(admin.publicKey), rw(account), ro(PROGRAM),
      rw(at('buffer', PROGRAM)), rw(at('delegation', DELEGATION)),
      rw(at('delegation-metadata', DELEGATION)),
      ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([
      header(2), u32(seeds.length),
      ...seeds.map((s) => Buffer.concat([u32(s.length), s])),
      ER_VALIDATOR.toBuffer(),
    ]),
  });
};

const ownerOf = async (key) => (await base.getAccountInfo(key))?.owner ?? null;

const validatorOf = async (key) => {
  const rec = await base.getAccountInfo(pda([Buffer.from('delegation'), key.toBuffer()], DELEGATION));
  return rec ? new PublicKey(rec.data.subarray(8, 40)) : null;
};

async function awaitOwner(key, want, label) {
  for (let i = 0; i < 40; i++) {
    const o = await ownerOf(key);
    if (o?.equals(want)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`     ⚠ ${label}: never came back to ${want.toBase58().slice(0, 8)}…`);
  return false;
}

// What moves, and what each one comes home to.
const targets = [
  { name: 'dev ledger',     key: ledgerPda(admin.publicKey), home: VAULT },
  { name: 'house ledger',   key: ledgerPda(house),           home: VAULT },
  { name: 'jackpot ledger', key: ledgerPda(jackpot),         home: VAULT },
  { name: 'house PDA',      key: house,                      home: PROGRAM },
  { name: 'analytics PDA',  key: analytics,                  home: PROGRAM },
];

console.log('target validator', ER_VALIDATOR.toBase58(), '\n');
console.log('before:');
for (const t of targets) {
  const o = await ownerOf(t.key);
  const v = o?.equals(DELEGATION) ? await validatorOf(t.key) : null;
  console.log(`  ${t.name.padEnd(15)} ${v ? `delegated → ${v.toBase58()}` : `owner ${o?.toBase58() ?? 'absent'}`}`);
}

console.log('\n1. undelegate');
for (const t of targets) {
  const o = await ownerOf(t.key);
  if (!o?.equals(DELEGATION)) { console.log(`  ⏭  ${t.name} already home`); continue; }
  const v = await validatorOf(t.key);
  if (v?.equals(ER_VALIDATOR)) { console.log(`  ⏭  ${t.name} already on the target`); continue; }
  try {
    const ix = t.key.equals(house) || t.key.equals(analytics) ? undelegatePdaIx(t.key)
             : t.key.equals(ledgerPda(admin.publicKey)) ? undelegateWalletLedgerIx(admin.publicKey)
             : t.key.equals(ledgerPda(house)) ? undelegateTreasuryIx(0, house)
             : undelegateTreasuryIx(1, jackpot);
    await send(await rollupFor(v), [ix], [admin]);
    console.log(`  ${await awaitOwner(t.key, t.home, t.name) ? '✅' : '⚠️ '} ${t.name}`);
  } catch (e) {
    console.log(`  ❌ ${t.name}  ${String(e).split('\n')[0]}`);
  }
}

if (UNDELEGATE_ONLY) {
  console.log('\n--undelegate: stopping before re-delegation');
  process.exit(0);
}

console.log('\n2. delegate to the ER');
const steps = [
  ['dev ledger',     () => delegateWalletLedgerIx(admin.publicKey), ledgerPda(admin.publicKey)],
  ['house ledger',   () => delegateLedgerIx(0, house),              ledgerPda(house)],
  ['jackpot ledger', () => delegateLedgerIx(1, jackpot),            ledgerPda(jackpot)],
  ['house PDA',      () => delegatePdaIx(house, [Buffer.from('house')]), house],
  ['analytics PDA',  () => delegatePdaIx(analytics, [Buffer.from('analytics')]), analytics],
];
for (const [name, build, key] of steps) {
  const o = await ownerOf(key);
  if (o?.equals(DELEGATION)) { console.log(`  ⏭  ${name} already delegated`); continue; }
  try {
    await send(base, [build()], [admin]);
    const v = await validatorOf(key);
    console.log(`  ${v?.equals(ER_VALIDATOR) ? '✅' : '⚠️ '} ${name}  → ${v?.toBase58() ?? 'not delegated'}`);
  } catch (e) {
    console.log(`  ❌ ${name}  ${String(e).split('\n')[0]}`);
    for (const l of (e?.transactionLogs || e?.logs || []).slice(-6)) console.log('       ', l);
  }
}

console.log('\nafter:');
for (const t of targets) {
  const o = await ownerOf(t.key);
  const v = o?.equals(DELEGATION) ? await validatorOf(t.key) : null;
  console.log(`  ${t.name.padEnd(15)} ${v ? `delegated → ${v.toBase58()}` : `owner ${o?.toBase58() ?? 'absent'}`}`);
}
process.exit(0);
