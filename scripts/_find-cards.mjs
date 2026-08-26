import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const conn = new Connection(`https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');
const user = process.argv[2];
try {
  const all = await conn.getProgramAccounts(PROGRAM, {
    filters: [{ dataSize: 112 }, ...(user ? [{ memcmp: { offset: 16, bytes: user } }] : [])],
  });
  console.log(`getProgramAccounts: ${all.length} card account(s)`);
  for (const { pubkey, account } of all) {
    const d = account.data;
    console.log(' ', pubkey.toBase58().slice(0, 10) + '…',
      'user', new PublicKey(d.subarray(16, 48)).toBase58().slice(0, 8) + '…',
      'cardId', Number(d.readBigUInt64LE(48)),
      'status', Number(d.readBigUInt64LE(64)));
  }
} catch (e) {
  console.log('getProgramAccounts FAILED:', String(e.message || e).split('\n')[0]);
}
