// Keeps the house liquid: for every mint on the sheet, the house ledger must cover the worst
// single-card payout of that mint, times a safety factor. A collect must never fail because
// the house ran out of a token it printed on a card.
//
//   node scripts/top-up.mjs                 # check, then top up whatever is short
//   node scripts/top-up.mjs --check         # report only, change nothing
//   node scripts/top-up.mjs --factor 5      # buffer = worst case × factor      (default 5)
//   node scripts/top-up.mjs --fill          # top up anything below target, not below half
//
// The worst case is a closed form off the published sheet (sheet.mjs worstCases): the dearest
// single collect a card can produce, stacking included. The factor names the float itself: the
// house is held at worst × factor per token, refilled whenever it slips below half that, back
// to the full target — the half-way trigger is hysteresis, so runs don't graze the threshold.
//
// Every row is funded the same way — deposited to the admin's ledger and settled admin →
// house, the canonical path. What differs is the source: devnet tokens are minted (the admin
// holds every stand-in's mint authority), mainnet tokens must already sit in the admin's own
// token accounts (shortfalls are reported, not conjured), and SOL — any cluster — moves
// straight from the admin wallet, no mint and no token account involved.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import crypto from 'crypto';
import { whole, worstCases } from './sheet.mjs';
import { decodeLedger, SOL_MINT } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { MAINNET, BASENET, TEE, MINTS } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const mints = MINTS;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const CHECK = args.includes('--check');
const FACTOR = flag('factor', 5);
const FILL = process.argv.includes('--fill');

// ── shared plumbing, the same shapes play-devnet uses ────────────────────────

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const anchorDisc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const housePda = () => pda([Buffer.from('house')], PROGRAM);
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const reservePda = () => pda([Buffer.from('vault')], VAULT);
const permPda = (a) => pda([Buffer.from('permission:'), a.toBuffer()], PERMISSION);
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
// Which token program owns each mint — Token-2022 assets (PUMP) derive different ATAs and
// their vault transfers carry the mint. Filled per symbol on first use.
const programOf = {};
const tokenProgramOf = async (sym) => {
  if (sym === 'SOL') return TOKEN;
  if (!programOf[sym]) {
    const info = await base.getAccountInfo(mintOf(sym));
    programOf[sym] = info?.owner ?? TOKEN;
  }
  return programOf[sym];
};
const ataOf = (o, m, prog = TOKEN) => PublicKey.findProgramAddressSync(
  [o.toBuffer(), prog.toBuffer(), m.toBuffer()], ATA_PROGRAM)[0];

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

// Never preflight against the rollup — see play-devnet.mjs for the whole story.
const send = (conn, ixs, signers) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers,
    { commitment: 'confirmed', skipPreflight: conn !== base });

const createAtaIdempotentIx = (payer, owner, mint, prog = TOKEN) => new TransactionInstruction({
  programId: ATA_PROGRAM,
  keys: [sg(payer), rw(ataOf(owner, mint, prog)), ro(owner), ro(mint),
         ro(SystemProgram.programId), ro(prog)],
  data: Buffer.from([1]),
});

const mintToIx = (mint, dest, amount) => new TransactionInstruction({
  programId: TOKEN,
  keys: [rw(mint), rw(dest), sgro(admin.publicKey)],
  data: Buffer.concat([Buffer.from([7]), u64(amount)]),
});

const vaultDepositIx = (owner, mint, amount, prog = TOKEN) => {
  const ledger = ledgerPda(owner);
  const isSol = mint.equals(SOL_MINT);
  const keys = [
    sg(owner), rw(ledger), rw(permPda(ledger)), ro(PERMISSION), rw(reservePda()),
    isSol ? ro(SystemProgram.programId) : rw(ataOf(reservePda(), mint, prog)),
    isSol ? ro(SystemProgram.programId) : rw(ataOf(owner, mint, prog)),
    ro(prog), ro(SystemProgram.programId),
  ];
  // Token-2022 transfers are checked, and checked transfers carry the mint.
  if (!isSol && prog.equals(T22)) keys.push(ro(mint));
  return new TransactionInstruction({
    programId: VAULT,
    keys,
    data: Buffer.concat([anchorDisc('deposit'), mint.toBuffer(), u64(amount),
                         Buffer.from([0]), Buffer.from([0])]),
  });
};

/** The wire mint for a symbol — SOL is the all-zero mint, everything else is on the sheet. */
const mintOf = (sym) => (sym === 'SOL' ? SOL_MINT : new PublicKey(mints[sym]));

const delegateLedgerIx = (owner, validator) => {
  const ledger = ledgerPda(owner);
  const b = (tag, prog) => pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({
    programId: VAULT,
    keys: [
      sg(admin.publicKey), sgro(owner),
      rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
      rw(ledger),
      ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
    ],
    data: Buffer.concat([anchorDisc('delegate_ledger'), Buffer.from([1]), validator.toBuffer()]),
  });
};

const undelegateLedgerIx = (owner) => new TransactionInstruction({
  programId: VAULT,
  keys: [sg(admin.publicKey), sgro(owner), rw(ledgerPda(owner)), ro(MAGIC_PROGRAM),
         rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT)],
  data: anchorDisc('undelegate'),
});

/** Settle (vault, top-level): src → dst. The debited side signs; here that is the admin. */
const settleIx = (srcOwner, dstOwner, mint, amount) => new TransactionInstruction({
  programId: VAULT,
  keys: [
    rw(ledgerPda(srcOwner)), rw(ledgerPda(dstOwner)),
    sgro(srcOwner), ro(dstOwner),
  ],
  data: Buffer.concat([anchorDisc('settle'), mint.toBuffer(), u64(amount)]),
});

const awaitOwner = async (owner, want, label) => {
  for (let i = 0; i < 40; i++) {
    const info = await base.getAccountInfo(ledgerPda(owner));
    if (info?.owner.equals(want)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${label}: ledger owner never became ${want.toBase58()}`);
};

// ── 1. what the sheet can pay ────────────────────────────────────────────────

const worst = await worstCases();

// ── 2. what the house actually holds ─────────────────────────────────────────

// A plain member read: the house ledger's permission names the admin — the sponsor may see
// what it sponsors — so the admin token is served the account like any other member.
const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
  { commitment: 'confirmed', fetch: fetchRetrying });

const readHouse = async () => {
  const info = await tee.getAccountInfo(ledgerPda(housePda()));
  const l = info && decodeLedger(info.data);
  if (!l) throw new Error('cannot read the house ledger on the rollup');
  return { sol: l.sol, balances: l.balances };
};

const house = await readHouse();
const held = (sym) => {
  if (sym === 'SOL') return house.sol;
  return house.balances[mints[sym]] ?? 0n;
};

// ── 3. the gap ───────────────────────────────────────────────────────────────

const roundUp = (n) => {
  if (n <= 10n) return n;
  let step = 1n;
  while (step * 100n < n) step *= 10n;
  return ((n + step - 1n) / step) * step;
};

const rows = [];
const shortfalls = [];
for (const [sym, worstCase] of Object.entries(worst).sort()) {
  // The factor names the float itself: target = worst × factor. A run refills anything below
  // half its target back to the full target — the half-way trigger is only hysteresis, so
  // consecutive runs don't graze the threshold. (Times 100 and back down, so a fractional
  // factor like 1.5 survives the BigInt math.)
  const target = (worstCase * BigInt(Math.round(FACTOR * 100))) / 100n;
  const balance = held(sym);
  // `--fill` tops up anything under target rather than under half of it. The hysteresis is
  // right for routine runs, but it is the wrong rule straight after acquire-float: that buys
  // the exact shortfall to target, and a house sitting just above half would leave the tokens
  // it just bought stranded in the admin's wallet.
  const short = balance < (FILL ? target : target / 2n);
  if (short) {
    shortfalls.push({ sym, amount: roundUp(target - balance) });
  }
  rows.push({
    sym,
    worst: whole(sym, Number(worstCase)),
    target: whole(sym, Number(target)),
    balance: whole(sym, Number(balance)),
    state: short ? 'SHORT' : 'ok',
  });
}

console.log(`\nhouse ledger vs a float of worst case × ${FACTOR} (refill below ${FILL ? 'target' : 'half'}):`);
for (const r of rows) {
  console.log(`  ${r.sym.padEnd(7)} holds ${String(r.balance).padStart(12)}` +
    `  worst ${String(r.worst).padStart(10)}  target ${String(r.target).padStart(12)}  ${r.state}`);
}

if (!shortfalls.length) { console.log('\nnothing to do.'); process.exit(0); }
if (CHECK) { console.log('\n--check: not topping up.'); process.exit(0); }

// ── 4. mint, deposit, delegate, settle ───────────────────────────────────────

// What can actually move: SOL comes from the admin wallet itself (minus a fee reserve, on
// either cluster); devnet tokens are mintable so always fundable; mainnet tokens only from
// what the admin's own token accounts hold. Checked before touching delegation.
const FEE_RESERVE = 50_000_000n;
const funded = [];
for (const s of shortfalls) {
  if (s.sym === 'SOL') {
    const spendable = BigInt(await base.getBalance(admin.publicKey)) - FEE_RESERVE;
    if (spendable >= s.amount) funded.push(s);
    else console.log(`  SOL: SHORT — wallet has ${spendable} spendable lamports, ` +
      `needs ${s.amount}; fund the admin wallet and re-run`);
    continue;
  }
  if (!MAINNET) { funded.push(s); continue; }
  const bal = await base.getTokenAccountBalance(
    ataOf(admin.publicKey, mintOf(s.sym), await tokenProgramOf(s.sym))).catch(() => null);
  const available = bal ? BigInt(bal.value.amount) : 0n;
  if (available >= s.amount) funded.push(s);
  else console.log(`  ${s.sym}: SHORT — admin holds ${available}, needs ${s.amount}; ` +
    'acquire and re-run');
}
if (!funded.length) { console.log('\nnothing fundable from the admin accounts.'); process.exit(1); }

const feesBefore = await base.getBalance(admin.publicKey);
console.log(`\ntopping up ${funded.map((s) => `${s.amount} ${s.sym}`).join(', ')}`);

// The admin's ledger has to be at home to deposit into, and on the rollup to settle from.
const adminLedger = await base.getAccountInfo(ledgerPda(admin.publicKey));
if (adminLedger?.owner.equals(DELEGATION)) {
  console.log('admin ledger is delegated — bringing it home first');
  const adminTee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
    { commitment: 'confirmed', fetch: fetchRetrying });
  await send(adminTee, [undelegateLedgerIx(admin.publicKey)], [admin]);
  await awaitOwner(admin.publicKey, VAULT, 'undelegate');
}

for (const { sym, amount } of funded) {
  const mint = mintOf(sym);
  const prog = await tokenProgramOf(sym);
  const ixs = [];
  if (sym !== 'SOL') {
    ixs.push(
      createAtaIdempotentIx(admin.publicKey, admin.publicKey, mint, prog),
      createAtaIdempotentIx(admin.publicKey, reservePda(), mint, prog),
    );
    if (!MAINNET) ixs.push(mintToIx(mint, ataOf(admin.publicKey, mint), amount));
  }
  ixs.push(vaultDepositIx(admin.publicKey, mint, amount, prog));
  await send(base, ixs, [admin]);
  console.log(`  ${sym === 'SOL' || MAINNET ? 'deposited' : 'minted and deposited'} ${amount} ${sym}`);
}

// The same validator the house is on, read off its delegation record.
const houseRec = await base.getAccountInfo(
  pda([Buffer.from('delegation'), ledgerPda(housePda()).toBuffer()], DELEGATION));
if (!houseRec) throw new Error('house ledger is not delegated — nothing to settle against');
const validator = new PublicKey(houseRec.data.subarray(8, 40));

await send(base, [delegateLedgerIx(admin.publicKey, validator)], [admin]);
await awaitOwner(admin.publicKey, DELEGATION, 'delegate');
console.log('admin ledger delegated');

// The rollup clones lazily; wait until the ledger is actually live there.
const adminTee = new Connection(`${TEE}?token=${await teeToken(admin)}`,
  { commitment: 'confirmed', fetch: fetchRetrying });
for (let i = 0; i < 40; i++) {
  if (await adminTee.getAccountInfo(ledgerPda(admin.publicKey))) break;
  await new Promise((r) => setTimeout(r, 1500));
  if (i === 39) throw new Error('admin ledger never appeared on the rollup');
}

for (const { sym, amount } of funded) {
  await send(adminTee,
    [settleIx(admin.publicKey, housePda(), mintOf(sym), amount)], [admin]);
  console.log(`  settled ${amount} ${sym} → house`);
}

// ── 5. the receipt ───────────────────────────────────────────────────────────

const after = await readHouse();
console.log('\nhouse ledger after:');
for (const { sym } of funded) {
  const now = sym === 'SOL' ? after.sol : after.balances[mints[sym]] ?? 0n;
  console.log(`  ${sym.padEnd(7)} ${now}`);
}
const feesAfter = await base.getBalance(admin.publicKey);
console.log(`\nthis run cost ${((feesBefore - feesAfter) / 1e9).toFixed(6)} SOL in fees and rent`);
console.log('(the admin ledger stays delegated; the next run brings it home itself)');
