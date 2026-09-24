// Closes cards of a layout this program no longer reads: the ones on the rollup from before the
// current seeds, which `close_card` cannot reach by user. Lists every card-discriminator account
// the admin can see on the TEE and closes each by address; the program refuses a card of the
// current size, so a live ticket is never touched. Admin only.
//
//   node scripts/close-stray-cards.mjs            dry run: list them
//   node scripts/close-stray-cards.mjs --go       close them

import fs from 'fs';
import os from 'os';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { teeEndpoint } from './tee-auth.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const CARD_DISCRIMINATOR = 3;
const CLOSE_STRAY_CARD = 31;
const housePda = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM)[0];
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });

const KEYS = process.env.KEYS_DIR ?? `${os.homedir()}/keys`;
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${KEYS}/casino_admin.json`))));
const go = process.argv.includes('--go');
const er = new Connection(await teeEndpoint(admin), 'confirmed');

const cards = await er.getProgramAccounts(PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: '4' } }] });
console.log(`${cards.length} card accounts visible to the admin`);
for (const { pubkey, account } of cards) {
  console.log(`  ${pubkey.toBase58()}  ${account.data.length} B  ${account.lamports} lamports`);
}
if (!go) { console.log('\ndry run — pass --go to close them'); process.exit(0); }

let closed = 0;
for (const { pubkey } of cards) {
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    keys: [sg(admin.publicKey), rw(housePda), rw(pubkey), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM)],
    data: Buffer.from(new BigUint64Array([BigInt(CLOSE_STRAY_CARD)]).buffer),
  });
  try {
    const sig = await sendAndConfirmTransaction(er, new Transaction().add(ix), [admin], { skipPreflight: true });
    const gone = !(await er.getAccountInfo(pubkey));
    console.log(`  ${pubkey.toBase58().slice(0, 8)} ${gone ? 'closed' : 'still there'}  ${sig.slice(0, 12)}…`);
    if (gone) closed++;
  } catch (e) {
    const logs = (typeof e.getLogs === 'function' ? await e.getLogs(er).catch(() => null) : e.logs) ?? [];
    console.log(`  ${pubkey.toBase58().slice(0, 8)} refused: ${e.transactionMessage ?? String(e.message).slice(0, 80)}`);
    for (const l of logs.filter((l) => /failed|rror/.test(l)).slice(-2)) console.log(`      ${l.slice(0, 120)}`);
    if (!logs.length) { const sim = await er.simulateTransaction(new Transaction().add(ix), [admin]).catch((x) => ({ value: { err: String(x.message).slice(0, 80), logs: [] } })); console.log(`      simulate: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).filter((l) => /failed|rror/.test(l)).slice(-1).join(' ')}`); }
    break;
  }
}
console.log(`\n${closed}/${cards.length} closed`);
