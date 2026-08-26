// Open the house + jackpot vault ledgers under the (new) vault. basenet, admin-signed, idempotent.
//   node scripts/open-treasuries.mjs
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { BASENET } from './net.mjs';

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');
const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const ledgerPda = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const permPda = (a) => pda([Buffer.from('permission:'), a.toBuffer()], PERMISSION);
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const openIx = (treasury, which, slots) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    sg(admin.publicKey), ro(treasury), rw(ledgerPda(treasury)),
    rw(permPda(ledgerPda(treasury))), ro(PERMISSION), ro(VAULT), ro(SystemProgram.programId),
  ],
  data: Buffer.concat([header(15), Buffer.from([which]), u16(slots)]),
});

for (const [name, which, slots] of [['house', 0, 20], ['jackpot', 1, 4]]) {
  const treasury = pda([Buffer.from(name)], PROGRAM);
  const ledger = ledgerPda(treasury);
  if (await base.getAccountInfo(ledger)) { console.log(`  ⏭  ${name} ledger already exists ${ledger.toBase58()}`); continue; }
  const sig = await sendAndConfirmTransaction(base, new Transaction().add(openIx(treasury, which, slots)), [admin], { commitment: 'confirmed' });
  console.log(`  ✅ ${name} ledger ${ledger.toBase58()}  (${slots} slots)  tx ${sig.slice(0, 16)}…`);
}
