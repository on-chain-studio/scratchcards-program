// settle_external forwarded caller-chosen accounts to a caller-chosen program — an
// exfiltration tool. Confirm the live vault no longer answers to it.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const disc = crypto.createHash('sha256').update('global:settle_external').digest().subarray(0, 8);
const tx = new Transaction().add(new TransactionInstruction({
  programId: VAULT,
  keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }],
  data: Buffer.concat([disc, Buffer.from([0, 0, 0, 0])]),
}));
tx.feePayer = admin.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(admin);
try {
  const sim = await conn.simulateTransaction(tx);
  const err = JSON.stringify(sim.value.err);
  const logs = (sim.value.logs ?? []).join(' ');
  console.log('settle_external:',
    logs.includes('Fallback functions are not supported') || err.includes('101')
      ? 'GONE — no such instruction'
      : `still answers? err=${err}`);
} catch (e) { console.log('probe error:', String(e).split('\n')[0]); }
