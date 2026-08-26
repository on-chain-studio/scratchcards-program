// Buys the token float with SOL through Jupiter — the acquisition half of house liquidity.
// For every token the house is short (worst single collect × factor, minus what the house
// ledger and the admin's own token accounts already hold), quotes an exact-out swap and
// prints the plan. Nothing moves without --swap; after swapping, top-up.mjs moves the tokens
// from the admin's accounts into the house.
//
//   node scripts/acquire-float.mjs --mainnet --factor 1.5             # plan: quotes only
//   node scripts/acquire-float.mjs --mainnet --factor 1.5 --swap      # execute the plan
//   node scripts/acquire-float.mjs --mainnet --slippage 150           # slippage in bps (default 100)
//
// Mainnet only: the devnet stand-ins are not on Jupiter — devnet float is minted by top-up.

import fs from 'fs';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ADMIN_PATH, BASENET, TEE, MAINNET, MINTS } from './net.mjs';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { whole, worstCases, loadPrices } from './sheet.mjs';

if (!MAINNET) {
  console.error('mainnet only — devnet float is minted by top-up.mjs, nothing to buy');
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const SWAP = args.includes('--swap');
const FACTOR = flag('factor', 1.5);
const SLIPPAGE_BPS = flag('slippage', 100);
const FEE_RESERVE = 50_000_000;

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag/swap/v1';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');
const pda = (s, p = PROGRAM) => PublicKey.findProgramAddressSync(s, p)[0];
const house = pda([Buffer.from('house')]);
const houseLedger = pda([Buffer.from('ledger'), house.toBuffer()], VAULT);
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const programCache = {};
const ataOf = async (mint) => {
  const m = new PublicKey(mint);
  if (!programCache[mint]) {
    programCache[mint] = (await base.getAccountInfo(m))?.owner ?? TOKEN;
  }
  return PublicKey.findProgramAddressSync(
    [admin.publicKey.toBuffer(), programCache[mint].toBuffer(), m.toBuffer()], ATA_PROGRAM)[0];
};

const jup = async (path) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${JUP}${path.url}`, path.init);
      if (r.ok) return r.json();
      last = `${r.status} ${await r.text().catch(() => '')}`.slice(0, 160);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = String(e.cause ?? e).slice(0, 160);
    }
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error(`jupiter: ${last}`);
};

// ── what the house is short ──────────────────────────────────────────────────

const worst = await worstCases();

const houseInfo = await base.getAccountInfo(houseLedger);
const houseLive = houseInfo?.owner.equals(DELEGATION)
  ? await new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed').getAccountInfo(houseLedger)
  : houseInfo;
const held = houseLive ? decodeLedger(houseLive.data) : null;

// The same headroom rounding top-up applies — buying the exact target leaves the wallet one
// rounding step short of what top-up then asks for, and the row gets skipped.
const roundUp = (n) => {
  if (n <= 10n) return n;
  let step = 1n;
  while (step * 100n < n) step *= 10n;
  return ((n + step - 1n) / step) * step;
};

const plan = [];
for (const [sym, w] of Object.entries(worst).sort()) {
  if (sym === 'SOL') continue; // SOL float comes from the wallet via top-up, not a swap
  const mint = MINTS[sym];
  if (!mint) continue;
  const target = (w * BigInt(Math.round(FACTOR * 100))) / 100n;
  const inHouse = held?.balances[mint] ?? 0n;
  const ata = await base.getTokenAccountBalance(await ataOf(mint)).catch(() => null);
  const inAta = ata ? BigInt(ata.value.amount) : 0n;
  const need = roundUp(target - inHouse) - inAta;
  if (need <= 0n) { console.log(`  ${sym.padEnd(7)} covered (house ${inHouse}, wallet ${inAta})`); continue; }
  plan.push({ sym, mint, need });
}

if (!plan.length) { console.log('\nnothing to buy.'); process.exit(0); }

// ── quotes ───────────────────────────────────────────────────────────────────

console.log('\nquoting SOL → token:');
let totalIn = 0n;
for (const p of plan) {
  const q = (amount, mode) => jup({
    url: `/quote?inputMint=${WSOL}&outputMint=${p.mint}&amount=${amount}` +
         `&swapMode=${mode}&slippageBps=${SLIPPAGE_BPS}`,
  });
  try {
    p.quote = await q(p.need, 'ExactOut');
    p.mode = 'exact';
  } catch (e) {
    if (!String(e).includes('NO_ROUTES')) throw e;
    // Some routes (pump.fun pools among them) only quote exact-in: probe the price with a
    // small quote, then size the input with a small pad — top-up moves whatever lands.
    const probe = await q(100_000_000n, 'ExactIn');
    const inSized = (p.need * 100_000_000n) / BigInt(probe.outAmount) * 103n / 100n;
    p.quote = await q(inSized, 'ExactIn');
    p.mode = '~in';
  }
  p.inLamports = BigInt(p.quote.inAmount);
  totalIn += p.inLamports;
  // What the swap really costs over spot: AMM fees + price impact + drift since prices.json.
  const { prices } = loadPrices();
  const paidUsd = (Number(p.inLamports) / 1e9) * (prices.SOL ?? 0);
  const spotUsd = whole(p.sym, Number(p.quote.outAmount ?? p.need)) * (prices[p.sym] ?? 0);
  const premium = spotUsd > 0 ? (paidUsd / spotUsd - 1) * 100 : 0;
  const impact = Number(p.quote.priceImpactPct ?? 0) * 100;
  console.log(`  ${p.sym.padEnd(7)} buy ${whole(p.sym, Number(p.need)).toLocaleString().padStart(14)}` +
    `  for ${(Number(p.inLamports) / 1e9).toFixed(4)} SOL` +
    `   over spot ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}%  impact ${impact.toFixed(3)}%` +
    `${p.mode === '~in' ? '  (exact-in, ~3% pad)' : ''}`);
}
const balance = await base.getBalance(admin.publicKey);
console.log(`\ntotal: ${(Number(totalIn) / 1e9).toFixed(4)} SOL — wallet holds ${(balance / 1e9).toFixed(4)}`);
if (balance < Number(totalIn) + FEE_RESERVE) {
  console.log(`⚠ short by ${((Number(totalIn) + FEE_RESERVE - balance) / 1e9).toFixed(4)} SOL (keeping a ${FEE_RESERVE / 1e9} fee reserve)`);
  if (SWAP) process.exit(1);
}
if (!SWAP) { console.log('\nplan only — pass --swap to execute, then run top-up.mjs to move it into the house'); process.exit(0); }

// ── swaps ────────────────────────────────────────────────────────────────────

const feesBefore = await base.getBalance(admin.publicKey);
for (const p of plan) {
  const { swapTransaction } = await jup({
    url: '/swap',
    init: {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: p.quote,
        userPublicKey: admin.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 'auto',
      }),
    },
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([admin]);
  const sig = await base.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await base.confirmTransaction(sig, 'confirmed');
  const after = await base.getTokenAccountBalance(await ataOf(p.mint)).catch(() => null);
  console.log(`  ✅ ${p.sym.padEnd(7)} ${sig.slice(0, 20)}…  wallet now holds ${after?.value.amount ?? '?'}`);
}
console.log(`\nthis run cost ${((feesBefore - await base.getBalance(admin.publicKey)) / 1e9).toFixed(4)} SOL (swaps included)`);
console.log('now: node scripts/top-up.mjs --mainnet --factor ' + FACTOR);
