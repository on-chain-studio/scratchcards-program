// One JSON blob for the sheet console's treasury table: the house ledger (pays wins at
// settle), the vault's basenet pools (pay withdrawals), and the sheet's worst single
// collect per token — the same worst-case the float keeper sizes against, so the console
// and the keeper cannot disagree about what "enough" means.
//
//   node scripts/_balances-json.mjs [--mainnet]

import fs from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { whole, worstCases } from './sheet.mjs';
import { ADMIN_PATH, BASENET, TEE, MINTS } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const house = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM)[0];
const houseLedger = PublicKey.findProgramAddressSync([Buffer.from('ledger'), house.toBuffer()], VAULT)[0];
const vaultPda = PublicKey.findProgramAddressSync([Buffer.from('vault')], VAULT)[0];
const bySym = Object.fromEntries(Object.entries(MINTS).map(([s, m]) => [m, s]));

const base = new Connection(BASENET, 'confirmed');

// House ledger — live copy is on the rollup while delegated.
const onBase = await base.getAccountInfo(houseLedger);
let where = 'basenet', ledgerInfo = onBase;
if (onBase?.owner.equals(DELEGATION)) {
  where = 'rollup (live)';
  ledgerInfo = await new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed')
    .getAccountInfo(houseLedger);
}
const ledger = ledgerInfo && decodeLedger(ledgerInfo.data);

// Basenet pools — the SPL tokens that actually leave on a withdraw.
const pools = {};
for (const program of [TOKEN, TOKEN22]) {
  const { value } = await base.getParsedTokenAccountsByOwner(vaultPda, { programId: program });
  for (const a of value) {
    const i = a.account.data.parsed.info;
    const sym = bySym[i.mint];
    if (sym) pools[sym] = Number(i.tokenAmount.amount);
  }
}
const poolSol = await base.getBalance(vaultPda);

const worst = await worstCases();
const prices = Object.fromEntries(Object.entries(
  JSON.parse(fs.readFileSync(new URL('./prices.json', import.meta.url), 'utf8')),
).filter(([, v]) => typeof v === 'number'));

const tokens = {};
const symbols = new Set([
  ...Object.keys(worst),
  ...Object.keys(pools),
  ...Object.entries(ledger?.balances ?? {}).map(([m]) => bySym[m]).filter(Boolean),
]);
for (const sym of symbols) {
  if (sym === 'SOL') continue;
  const mint = MINTS[sym];
  tokens[sym] = {
    house: whole(sym, Number(Object.entries(ledger?.balances ?? {})
      .find(([m]) => m === mint)?.[1] ?? 0)),
    pool: whole(sym, pools[sym] ?? 0),
    worst: whole(sym, Number(worst[sym] ?? 0n)),
    price: prices[sym] ?? 0,
  };
}

console.log(JSON.stringify({
  ok: true, where,
  sol: {
    house: Number(ledger?.sol ?? 0) / 1e9,
    pool: poolSol / 1e9,
    worst: Number(worst.SOL ?? 0n) / 1e9,
    price: prices.SOL ?? 0,
  },
  tokens,
}));
