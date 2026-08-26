// Delegate the house + jackpot vault ledgers to the same validator the house PDA is on. basenet, admin.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { BASENET } from './net.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');
const pda=(s,p)=>PublicKey.findProgramAddressSync(s,p)[0];
const house = pda([Buffer.from('house')], PROGRAM), jackpot = pda([Buffer.from('jackpot')], PROGRAM);
const ledgerPda=o=>pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const ro=k=>({pubkey:k,isSigner:false,isWritable:false}), rw=k=>({pubkey:k,isSigner:false,isWritable:true}), sg=k=>({pubkey:k,isSigner:true,isWritable:true});
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b}; const header=v=>{const b=Buffer.alloc(8);b[0]=v;return b};

// house PDA's current validator (both ledgers must match it)
const rec = await base.getAccountInfo(pda([Buffer.from('delegation'), house.toBuffer()], DELEGATION));
const VALIDATOR = new PublicKey(rec.data.subarray(8,40));
console.log('house PDA validator:', VALIDATOR.toBase58());

const delegateLedgerIx = (which, treasury) => {
  const ledger = ledgerPda(treasury);
  const b=(tag,prog)=>pda([Buffer.from(tag), ledger.toBuffer()], prog);
  return new TransactionInstruction({ programId: PROGRAM, keys: [
    sg(admin.publicKey), rw(treasury),
    rw(b('buffer', VAULT)), rw(b('delegation', DELEGATION)), rw(b('delegation-metadata', DELEGATION)),
    rw(ledger), ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId),
  ], data: Buffer.concat([header(16), Buffer.from([which]), VALIDATOR.toBuffer()]) });
};
const ownerOf=async k=>(await base.getAccountInfo(k))?.owner;
for (const [name, which, treasury] of [['house', 0, house], ['jackpot', 1, jackpot]]) {
  const ledger = ledgerPda(treasury);
  if ((await ownerOf(ledger))?.equals(DELEGATION)) { console.log(`  ⏭  ${name} ledger already delegated`); continue; }
  await sendAndConfirmTransaction(base, new Transaction().add(delegateLedgerIx(which, treasury)), [admin], { commitment: 'confirmed' });
  let ok=false; for (let i=0;i<40;i++){ if ((await ownerOf(ledger))?.equals(DELEGATION)){ok=true;break} await new Promise(r=>setTimeout(r,1500)); }
  console.log(`  ${ok?'✅':'⚠️ '} ${name} ledger delegated → ${VALIDATOR.toBase58().slice(0,8)}…`);
}
