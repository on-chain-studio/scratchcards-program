// Drops a card account and returns its rent to the house. Admin only.
//
//   node scripts/close-card.mjs [user]        default: the dev key
//
// The escape hatch for a card no normal path can reach — one a probe left with a zeroed user
// field, or one stranded between statuses. Cards live only on the rollup, so this runs there.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { decodeCard } from './accounts.mjs';
import { PUBLIC_ER as ER } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const user = process.argv[2] ? new PublicKey(process.argv[2]) : admin.publicKey;

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const house = pda([Buffer.from('house')]);
const card = pda([Buffer.from('card'), user.toBuffer()]);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

// ROLLUP=tee closes a card living on the private TEE instead of the public ER.
const { teeToken } = await import('./tee-auth.mjs');
const { TEE } = await import('./net.mjs');
const conn = new Connection(
  process.env.ROLLUP === 'tee' ? `${TEE}?token=${await teeToken(admin)}` : ER, 'confirmed');

console.log('user', user.toBase58());
console.log('card', card.toBase58());

const before = await conn.getAccountInfo(card);
if (!before) {
  console.log('  ▫ already absent');
  process.exit(0);
}
const decoded = decodeCard(before.data);
console.log(`  ${before.data.length} B, owner ${before.owner.toBase58()}`);
console.log(`  status ${decoded?.status}, user ${decoded?.user.toBase58()}, cardId ${decoded?.cardId}`);

try {
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(new TransactionInstruction({
      programId: PROGRAM,
      keys: [sg(admin.publicKey), rw(house), rw(card), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM)],
      data: Buffer.concat([header(7), user.toBuffer()]),
    })),
    [admin], { commitment: 'confirmed', skipPreflight: true },
  );
  console.log(`  ${sig}`);
  const after = await conn.getAccountInfo(card);
  console.log(after ? `  ⚠️  still there (${after.data.length} B)` : '  ✅ closed, rent back to the house');
} catch (e) {
  console.log(`  ❌ ${String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0]}`);
  for (const l of (e?.transactionLogs || e?.logs || []).slice(-8)) console.log('     ', l);
}
process.exit(0);
