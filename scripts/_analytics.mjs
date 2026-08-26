// Read-only: the analytics counters, live off the rollup when delegated (the admin is a
// permission member there), otherwise the basenet copy.
//
//   node scripts/_analytics.mjs [--mainnet]
//   node scripts/_analytics.mjs --json        machine-readable, for the sheet tool
//
// --json prints nothing but the JSON, so the tool's endpoint can parse stdout whole.

import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeAnalytics } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { whole } from './sheet.mjs';
import { ADMIN_PATH, BASENET, TEE, MINTS } from './net.mjs';

const JSON_OUT = process.argv.includes('--json');
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const analytics = PublicKey.findProgramAddressSync([Buffer.from('analytics')], PROGRAM)[0];

const fail = (error) => {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error }));
  else console.log(error);
  process.exit(1);
};

const base = new Connection(BASENET, 'confirmed');
const onBase = await base.getAccountInfo(analytics);
if (!onBase) fail('no analytics account — run setup-scratch');

let info = onBase, where = 'basenet';
if (onBase.owner.equals(DELEGATION)) {
  const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
  const live = await tee.getAccountInfo(analytics);
  if (live) { info = live; where = 'rollup (live)'; }
  else where = 'basenet (stale — rollup copy unreadable)';
}

const a = decodeAnalytics(info.data);
if (!a) fail('account too small to decode');

const nameOf = Object.fromEntries(Object.entries(MINTS).map(([sym, m]) => [m, sym]));
nameOf[PublicKey.default.toBase58()] = 'SOL';
const payouts = Object.entries(a.payouts).map(([mint, amount]) => {
  const token = nameOf[mint] ?? `${mint.slice(0, 8)}…`;
  return { token, amount: String(amount), whole: whole(token, Number(amount)) };
});

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: true, where,
    lamportsIn: String(a.lamportsIn), jackpotIn: String(a.jackpotIn),
    jackpotPaid: String(a.jackpotPaid), jackpotHits: Number(a.jackpotHits),
    cardsSold: a.cardsSold.map(Number), cardsCollected: a.cardsCollected.map(Number),
    payouts,
  }));
  process.exit(0);
}

const sol = (n) => `${(Number(n) / 1e9).toFixed(4)} SOL`;
console.log(`analytics ${analytics.toBase58()}  —  ${where}\n`);
console.log(`  taken in   ${sol(a.lamportsIn)}   (jackpot share ${sol(a.jackpotIn)})`);
console.log(`  jackpots   ${a.jackpotHits} paid, ${sol(a.jackpotPaid)} total`);
const sold = a.cardsSold.map((n, i) => [i, n]).filter(([, n]) => n > 0n);
console.log(`  cards      ${sold.map(([i, n]) => `#${i}×${n}`).join('  ') || 'none sold'}`);
const collected = a.cardsCollected.map((n, i) => [i, n]).filter(([, n]) => n > 0n);
if (collected.length) console.log(`  collected  ${collected.map(([i, n]) => `#${i}×${n}`).join('  ')}`);
console.log(payouts.length ? '  paid out:' : '  paid out   nothing yet');
for (const p of payouts) console.log(`    ${p.token.padEnd(8)} ${p.whole.toLocaleString()}`);
