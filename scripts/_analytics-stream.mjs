// Streams the analytics counters as JSON lines: the current state first, then one line per
// observed change (the sheet tool's dev server pipes this to the browser as server-sent
// events). Polls over HTTPS rather than holding an accountSubscribe: the desktop this runs
// on sleeps, and a woken subscription is a dead socket with an expired token — a poll that
// re-mints its token on failure survives that, at the cost of ~30s latency nobody watching
// a dashboard notices. Changes that happen while the machine is off are never seen as
// lines; the first poll after wake emits the caught-up state.
//
//   node scripts/_analytics-stream.mjs [--mainnet]

import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeAnalytics } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { whole } from './sheet.mjs';
import { ADMIN_PATH, BASENET, TEE, MINTS } from './net.mjs';

const POLL_MS = 30_000;

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const analytics = PublicKey.findProgramAddressSync([Buffer.from('analytics')], PROGRAM)[0];

const nameOf = Object.fromEntries(Object.entries(MINTS).map(([sym, m]) => [m, sym]));
nameOf[PublicKey.default.toBase58()] = 'SOL';

const render = (data, where) => {
  const a = decodeAnalytics(data);
  if (!a) return JSON.stringify({ ok: false, error: 'account too small to decode' });
  return JSON.stringify({
    ok: true, where,
    lamportsIn: String(a.lamportsIn), jackpotIn: String(a.jackpotIn),
    jackpotPaid: String(a.jackpotPaid), jackpotHits: Number(a.jackpotHits),
    cardsSold: a.cardsSold.map(Number), cardsCollected: a.cardsCollected.map(Number),
    payouts: Object.entries(a.payouts).map(([mint, amount]) => {
      const token = nameOf[mint] ?? `${mint.slice(0, 8)}…`;
      return { token, amount: String(amount), whole: whole(token, Number(amount)) };
    }),
  });
};

const base = new Connection(BASENET, 'confirmed');
const onBase = await base.getAccountInfo(analytics);
if (!onBase) { console.log(JSON.stringify({ ok: false, error: 'no analytics account — run setup-scratch' })); process.exit(1); }

const delegated = onBase.owner.equals(DELEGATION);
const where = delegated ? 'rollup (live)' : 'basenet';
let conn = delegated ? new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed') : base;

let last = '';
const tick = async () => {
  try {
    const data = (await conn.getAccountInfo(analytics))?.data;
    if (!data) return;
    const line = render(data, where);
    if (line !== last) { console.log(line); last = line; }
  } catch {
    // Most likely an expired TEE token after a long sleep — rebuild with a fresh one.
    if (delegated) try { conn = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed'); } catch {}
  }
};

await tick();
setInterval(tick, POLL_MS);
