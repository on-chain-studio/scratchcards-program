import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(`https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');
const sig = process.argv[2];
for (let i = 0; i < 10; i++) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (tx) { console.log((tx.meta?.logMessages ?? []).join('\n')); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('no transaction returned');
