// Does return data survive from one TOP-LEVEL instruction to the next?
//   ix0 = test_authorize (20)  → sets return data
//   ix1 = test_read_return (21) → logs whether it can see any
// Run on basenet: this is a runtime question, nothing to do with the rollup.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const house = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM)[0];
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });

// ix0: house-owned authorize, sets return data
const authorize = new TransactionInstruction({
  programId: PROGRAM, keys: [ro(house)],
  data: Buffer.concat([header(20), u64(1234), Buffer.from([1])]),
});
// ix1: read whatever return data is visible
const read = new TransactionInstruction({
  programId: PROGRAM, keys: [], data: header(21),
});

async function run(label, ixs) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed', skipPreflight: true });
  const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const lines = (t?.meta?.logMessages ?? []).filter((l) => l.includes('RETURN_DATA'));
  console.log(`${label}\n   ${lines.join('\n   ') || '(no log found)'}`);
}

await run('read alone (control — expect NONE)', [read]);
await run('authorize then read (the question)', [authorize, read]);
