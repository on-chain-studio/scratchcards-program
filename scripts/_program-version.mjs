// Is the rollup running the same binary as devnet? Compares the programdata account.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
const PROGRAMDATA = new PublicKey('Hhq6Fanj8iGG2XnMCh64ngng7z9p91KKLDbCU3LBAUH3');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
for (const [name, url] of [
  ['devnet', 'https://api.devnet.solana.com'],
  ['rollup', `https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`],
]) {
  try {
    const info = await new Connection(url, 'confirmed').getAccountInfo(PROGRAMDATA);
    if (!info) { console.log(`${name}: programdata absent`); continue; }
    const hash = crypto.createHash('sha256').update(info.data).digest('hex').slice(0, 16);
    console.log(`${name}: ${info.data.length} bytes, sha256 ${hash}`);
  } catch (e) { console.log(`${name}: ${e.message}`); }
}
