// Read-only: which card accounts exist, at what size, and whether they carry terms.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(
  `https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');
const all = await conn.getProgramAccounts(PROGRAM);
const cards = all.filter(a => a.account.data.length >= 112 &&
  Number(a.account.data.readBigUInt64LE(0)) === 3);
console.log(`card accounts: ${cards.length}`);
const bySize = {};
for (const c of cards) bySize[c.account.data.length] = (bySize[c.account.data.length] ?? 0) + 1;
console.log('sizes:', bySize);
cards.sort((a, b) => b.account.data.length - a.account.data.length);
for (const { pubkey, account } of cards.slice(0, 4)) {
  const d = account.data;
  const bits = [pubkey.toBase58().slice(0, 8) + '…', `${d.length}B`,
    'status', Number(d.readBigUInt64LE(64))];
  if (d.length >= 808) {
    bits.push('| terms kind', Number(d.readBigUInt64LE(112)),
      'price', Number(d.readBigUInt64LE(120)), 'poolLen', Number(d.readBigUInt64LE(160)));
  }
  console.log('  ', ...bits);
}
