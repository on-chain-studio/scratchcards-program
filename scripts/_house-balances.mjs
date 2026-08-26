import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';
import { BASENET, TEE, MINTS } from './net.mjs';


const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const SOL_MINT = new PublicKey('11111111111111111111111111111111');
// The admin — a member of the house ledger's permission as its sponsor. (This used to sign
// as the program keypair, until MagicBlock closed that hole: programs get no tokens.)
const progKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const house = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM)[0];
const ledger = PublicKey.findProgramAddressSync([Buffer.from('ledger'), house.toBuffer()], VAULT)[0];
const mints = MINTS;
const byAddr = Object.fromEntries(Object.entries(mints).map(([k, v]) => [v, k]));

async function dump(label, conn) {
  const i = await conn.getAccountInfo(ledger);
  if (!i) { console.log(`${label}: unreadable`); return; }
  const l = decodeLedger(i.data);
  if (!l) { console.log(`${label}: not a ledger`); return; }
  console.log(`\n${label} — ${l.slots} slots`);
  console.log(`  ${'SOL'.padEnd(8)} ${(Number(l.sol) / 1e9).toFixed(6)} SOL`);
  for (const [mint, amt] of Object.entries(l.balances)) {
    if (mint === PublicKey.default.toBase58()) continue;
    console.log(`  ${(byAddr[mint] ?? mint.slice(0, 8)).padEnd(8)} ${amt}`);
  }
}

await dump('basenet (frozen at delegation)', new Connection(BASENET, 'confirmed'));
try {
  const tee = new Connection(`${TEE}?token=${await teeToken(progKp)}`, 'confirmed');
  await dump('rollup (live)', tee);
} catch (e) { console.log('\nrollup read failed:', String(e).split('\n')[0]); }
