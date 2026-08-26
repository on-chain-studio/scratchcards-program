// Admission matrix for the analytics PDA vs the house ledger, per token identity.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { wallets } from './test-wallets.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const { player } = wallets(['player']);
const pda = (s, p = PROGRAM) => PublicKey.findProgramAddressSync(s, p)[0];
const house = pda([Buffer.from('house')]);
const analytics = pda([Buffer.from('analytics')]);
const houseLedger = pda([Buffer.from('ledger'), house.toBuffer()], VAULT);
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };

for (const [who, kp] of [['admin ', admin], ['player', player]]) {
  const tee = new Connection(`${TEE}?token=${await teeToken(kp)}`, 'confirmed');
  for (const [name, meta] of [['analytics rw   ', rw(analytics)], ['house ledger rw', rw(houseLedger)]]) {
    const ix = new TransactionInstruction({ programId: PROGRAM, keys: [meta], data: header(0) });
    try {
      await sendAndConfirmTransaction(tee, new Transaction().add(ix), [kp], { commitment: 'confirmed', skipPreflight: true });
      console.log(`✅ admitted  ${who}  ${name}`);
    } catch (e) {
      console.log(`❌ refused   ${who}  ${name}  ${String(e).split('\n')[0].slice(0, 90)}`);
    }
  }
}
process.exit(0);
