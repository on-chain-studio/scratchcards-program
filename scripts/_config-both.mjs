// Read-only: the config account as basenet holds it, and as the rollup holds it.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { MAGIC_RPC, TEE } from './net.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const pda = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM)[0];
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const show = async (label, url) => {
  const info = await new Connection(url, 'confirmed').getAccountInfo(pda);
  if (!info) return console.log(`${label.padEnd(8)} account not present`);
  const d = info.data;
  console.log(`${label.padEnd(8)} owner ${info.owner.toBase58().slice(0, 8)}…  ${d.length} bytes  ` +
    `disc ${d.readBigUInt64LE(0)}  version ${d.readBigUInt64LE(8)}  cards ${d.readBigUInt64LE(48)}  ` +
    `capacity ${Math.floor((d.length - 56) / 992)}`);
};
console.log(`config ${pda.toBase58()}\n`);
await show('basenet', MAGIC_RPC);
await show('rollup', `${TEE}?token=${await teeToken(admin)}`);
