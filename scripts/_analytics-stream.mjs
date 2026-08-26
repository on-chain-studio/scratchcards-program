// Streams the analytics counters as JSON lines: the current state first, then one line per
// on-chain change (accountSubscribe on the rollup where the account lives — the sheet tool's
// dev server pipes this to the browser as server-sent events).
//
//   node scripts/_analytics-stream.mjs [--mainnet]

import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeAnalytics } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { whole } from './sheet.mjs';
import { ADMIN_PATH, BASENET, TEE, MINTS } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const analytics = PublicKey.findProgramAddressSync([Buffer.from('analytics')], PROGRAM)[0];

const nameOf = Object.fromEntries(Object.entries(MINTS).map(([sym, m]) => [m, sym]));
nameOf[PublicKey.default.toBase58()] = 'SOL';

const emit = (data, where) => {
  const a = decodeAnalytics(data);
  if (!a) return console.log(JSON.stringify({ ok: false, error: 'account too small to decode' }));
  console.log(JSON.stringify({
    ok: true, where,
    lamportsIn: String(a.lamportsIn), jackpotIn: String(a.jackpotIn),
    jackpotPaid: String(a.jackpotPaid), jackpotHits: Number(a.jackpotHits),
    cardsSold: a.cardsSold.map(Number), cardsCollected: a.cardsCollected.map(Number),
    payouts: Object.entries(a.payouts).map(([mint, amount]) => {
      const token = nameOf[mint] ?? `${mint.slice(0, 8)}…`;
      return { token, amount: String(amount), whole: whole(token, Number(amount)) };
    }),
  }));
};

const base = new Connection(BASENET, 'confirmed');
const onBase = await base.getAccountInfo(analytics);
if (!onBase) { console.log(JSON.stringify({ ok: false, error: 'no analytics account — run setup-scratch' })); process.exit(1); }

let conn = base, where = 'basenet';
if (onBase.owner.equals(DELEGATION)) {
  conn = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
  where = 'rollup (live)';
}

emit((await conn.getAccountInfo(analytics))?.data ?? onBase.data, where);
conn.onAccountChange(analytics, (acc) => emit(acc.data, where), 'confirmed');
setInterval(() => {}, 1 << 30); // the subscription is the work; hold the process open
