import { Connection, PublicKey } from '@solana/web3.js';
const conn = new Connection('https://rpc.magicblock.app/devnet', 'confirmed');
const who = new PublicKey('691aFvKMnHXrMSgqk6G8izoCbVZTmkrRcu8xCeMKfPh1');
const sigs = await conn.getSignaturesForAddress(who, { limit: 12 });
console.log(`recent: ${sigs.length}`);
for (const s of sigs) {
  console.log(`${s.err ? 'FAILED ' : 'ok     '} ${s.signature.slice(0,20)}… ${new Date(s.blockTime*1000).toISOString().slice(11,19)}`);
}
const bad = sigs.find(s => s.err);
if (bad) {
  const tx = await conn.getTransaction(bad.signature, { maxSupportedTransactionVersion: 0 });
  console.log('\n--- error:', JSON.stringify(bad.err));
  console.log('--- logs ---');
  for (const l of (tx?.meta?.logMessages ?? [])) console.log('   ', l);
}
