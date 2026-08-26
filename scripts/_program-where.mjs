// Read-only: which binary each place is running.
//
// The rollup caches the program it cloned and does not re-clone when the deployed binary
// changes, so "I deployed it" and "the rollup runs it" are different facts. A v2 config met a
// v1 `Config::load` on the rollup and every purchase failed with InvalidAccountData while
// devnet was perfectly healthy — this is the one command that shows that split.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const PROGRAMDATA = new PublicKey('Hhq6Fanj8iGG2XnMCh64ngng7z9p91KKLDbCU3LBAUH3');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const local = fs.existsSync('target/deploy/scratch_cards.so')
  ? fs.readFileSync('target/deploy/scratch_cards.so') : null;

// programdata carries a 45-byte header before the ELF, so compare the payload, not the account.
const HEADER = 45;
const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
if (local) console.log(`local .so  ${String(local.length).padStart(7)} bytes  sha256 ${digest(local)}`);

for (const [name, url] of [
  ['devnet', 'https://api.devnet.solana.com'],
  ['TEE', `https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`],
  ['public ER', 'https://devnet.magicblock.app'],
]) {
  try {
    const info = await new Connection(url, 'confirmed').getAccountInfo(PROGRAMDATA);
    if (!info) { console.log(`${name.padEnd(10)} programdata absent`); continue; }
    const elf = info.data.subarray(HEADER, HEADER + (local?.length ?? info.data.length - HEADER));
    console.log(`${name.padEnd(10)} ${String(info.data.length).padStart(7)} bytes  sha256 ${digest(elf)}` +
      (local && digest(elf) === digest(local) ? '  ← current' : '  ← STALE'));
  } catch (e) { console.log(`${name.padEnd(10)} ${e.message}`); }
}
