// Pure admission matrix. Variant 0 is a deployed no-op that ignores its accounts, so each
// transaction here has zero execution semantics and zero side effects — the only thing the
// TEE can judge is the account list. Which writable addresses does it admit?
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')]);
const fresh = Keypair.generate().publicKey;

const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');

const cases = [
  ['card (refused before), ro   ', ro(pda([Buffer.from('card'), admin.publicKey.toBuffer()]))],
  ['card (refused before), rw   ', rw(pda([Buffer.from('card'), admin.publicKey.toBuffer()]))],
  ['receipt (admitted before), rw', rw(pda([Buffer.from('receipt'), house.toBuffer(), admin.publicKey.toBuffer()], VAULT))],
  ['fresh game PDA, rw           ', rw(pda([Buffer.from('card'), fresh.toBuffer()]))],
  ['fresh vault PDA, rw          ', rw(pda([Buffer.from('receipt'), house.toBuffer(), fresh.toBuffer()], VAULT))],
];

for (const [name, meta] of cases) {
  const ix = new TransactionInstruction({ programId: PROGRAM, keys: [meta], data: header(0) });
  try {
    await sendAndConfirmTransaction(tee, new Transaction().add(ix), [admin],
      { commitment: 'confirmed', skipPreflight: true });
    console.log(`✅ admitted  ${name}  ${meta.pubkey.toBase58()}`);
  } catch (e) {
    const status = String(e).match(/Status: \((.*?)\)/)?.[1] ?? String(e).split('\n')[0];
    console.log(`❌ refused   ${name}  ${meta.pubkey.toBase58()}\n             ${status}`);
  }
}
process.exit(0);
