// Refreshes scripts/prices.json from a live feed.
//
//   node scripts/fetch-prices.mjs
//
// The balance of the whole sheet is a function of what the payout tokens are worth, and the
// chain has no idea — so every prize tools/sheet solves rests on this file. Fetch before
// rebalancing, and rebalance again whenever these move far.
//
// The devnet mints are throwaways with no market, so prices come from the real tokens they
// stand in for. That mapping is the point of this file: it is the only place a devnet mint is
// tied to something with a price, and getting one wrong silently mis-values a card.

import fs from 'fs';

const API = 'https://api.coingecko.com/api/v3/simple/price';
const MAINNET = 'https://api.mainnet-beta.solana.com';

/** Payout token → the real asset it stands in for. */
const IDS = {
  SOL: 'solana',
  BONK: 'bonk',
  PENGU: 'pudgy-penguins',
  MEW: 'cat-in-a-dogs-world',
  WIF: 'dogwifcoin',
  PUMP: 'pump-fun',
  SKR: 'seeker',
  POPCAT: 'popcat',
  JTO: 'jito-governance-token',
  FART: 'fartcoin',
  PYTH: 'pyth-network',
  RAY: 'raydium',
  JUP: 'jupiter-exchange-solana',
  USDC: 'usd-coin',
};

const NOTE = 'Written by fetch-prices.mjs — run that rather than editing by hand, then re-run ' +
  'tools/sheet/rebalance.ts, because every amount on the sheet is set against these. Top level is USD per ' +
  'whole token; _decimals and _mints come from the mainnet mint accounts, _mcap and _volume are ' +
  'how liquid a payout token is.';

const before = fs.existsSync('scripts/prices.json')
  ? JSON.parse(fs.readFileSync('scripts/prices.json', 'utf8')) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mainnet decimals and mint, per token.
 *
 * A prize is stored in base units, so decimals decide what a stored amount is worth — get one
 * wrong and that token's payout is off by a power of ten. Two requests rather than one per
 * token: CoinGecko's full list carries every contract address at once, and the decimals then
 * come from the mint accounts themselves, which is the only authority that cannot be stale.
 * Decimals are fixed at mint creation, so anything already known is reused.
 */
async function fetchDecimals() {
  const decimals = { ...(before._decimals ?? {}), SOL: 9 };
  const mints = { ...(before._mints ?? {}), SOL: 'So11111111111111111111111111111111111111112' };
  const todo = Object.keys(IDS).filter((s) => typeof decimals[s] !== 'number');
  if (!todo.length) return { decimals, mints };

  const list = await fetch(`${API.replace('/simple/price', '')}/coins/list?include_platform=true`);
  if (!list.ok) { console.error(`coin list returned ${list.status} — decimals left unset`); return { decimals, mints }; }
  const byId = new Map((await list.json()).map((c) => [c.id, c]));

  const want = todo.filter((s) => byId.get(IDS[s])?.platforms?.solana);
  for (const s of todo) if (!want.includes(s)) console.error(`  ${s}: no Solana mint on CoinGecko`);
  for (const s of want) mints[s] = byId.get(IDS[s]).platforms.solana;
  if (!want.length) return { decimals, mints };

  const res = await fetch(MAINNET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
      params: [want.map((s) => mints[s]), { encoding: 'base64' }],
    }),
  });
  const body = await res.json();
  if (body.error) { console.error(`mint read failed: ${body.error.message}`); return { decimals, mints }; }

  want.forEach((s, i) => {
    const acc = body.result.value[i];
    if (!acc) { console.error(`  ${s}: mint ${mints[s]} not found`); return; }
    // SPL mint layout: authority option (36) + supply (8), then decimals — same in Token-2022
    decimals[s] = Buffer.from(acc.data[0], 'base64')[44];
    console.log(`  ${s.padEnd(7)} ${String(decimals[s]).padStart(2)} decimals   ${mints[s]}`);
  });
  return { decimals, mints };
}

const ids = [...new Set(Object.values(IDS))].join(',');
const res = await fetch(`${API}?ids=${ids}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`);
if (!res.ok) throw new Error(`price feed returned ${res.status} ${res.statusText}`);
const quoted = await res.json();

const out = { _note: NOTE, _fetched: new Date().toISOString() };
const mcap = {};
const vol = {};
const missing = [];
for (const [symbol, id] of Object.entries(IDS)) {
  const usd = quoted[id]?.usd;
  if (typeof usd !== 'number') { missing.push(`${symbol} (${id})`); continue; }
  out[symbol] = usd;
  if (typeof quoted[id].usd_market_cap === 'number') mcap[symbol] = quoted[id].usd_market_cap;
  if (typeof quoted[id].usd_24h_vol === 'number') vol[symbol] = quoted[id].usd_24h_vol;
}

if (missing.length) {
  console.error(`no quote for ${missing.join(', ')} — leaving prices.json alone`);
  process.exit(1);
}

const { decimals, mints } = await fetchDecimals();
out._decimals = decimals;
out._mints = mints;
out._mcap = mcap;
out._volume = vol;

const unknown = Object.keys(IDS).filter((s) => typeof decimals[s] !== 'number');
if (unknown.length) console.error(`\n⚠ no decimals for ${unknown.join(', ')} — those payouts cannot be valued`);

fs.writeFileSync('scripts/prices.json', JSON.stringify(out, null, 2) + '\n');

const fmt = (n) => (n >= 0.01 ? n.toFixed(4) : n.toPrecision(3));
for (const symbol of Object.keys(IDS)) {
  const was = before[symbol];
  const now = out[symbol];
  const move = typeof was === 'number' && was > 0
    ? `${now > was ? '+' : ''}${(((now - was) / was) * 100).toFixed(0)}%` : 'new';
  const big = (n) => (typeof n !== 'number' ? '—'
    : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`);
  console.log(`${symbol.padEnd(7)} $${fmt(now).padStart(10)}   ${move.padStart(7)}` +
    `   cap ${big(mcap[symbol]).padStart(7)}   vol ${big(vol[symbol]).padStart(7)}`);
}
console.log('\n→ scripts/prices.json   now re-run: (cd tools/sheet && npx vite-node rebalance.ts)');
