// Jackpot ledger: undelegate → make_public → re-delegate. (make_public needs the ledger home.)
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { BASENET, TEE } from './net.mjs';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const VALIDATOR = new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');
const pda=(s,p)=>PublicKey.findProgramAddressSync(s,p)[0];
const jackpot = pda([Buffer.from('jackpot')], PROGRAM);
const ledger = pda([Buffer.from('ledger'), jackpot.toBuffer()], VAULT);
const perm = pda([Buffer.from('permission:'), ledger.toBuffer()], PERMISSION);
const ro=k=>({pubkey:k,isSigner:false,isWritable:false}), rw=k=>({pubkey:k,isSigner:false,isWritable:true}), sg=k=>({pubkey:k,isSigner:true,isWritable:true}), sgro=k=>({pubkey:k,isSigner:true,isWritable:false});
const header=v=>{const b=Buffer.alloc(8);b[0]=v;return b}; const anchorDisc=n=>crypto.createHash('sha256').update('global:'+n).digest().subarray(0,8);
const ownerOf=async k=>(await base.getAccountInfo(k))?.owner; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const awaitOwner=async(k,want)=>{for(let i=0;i<40;i++){if((await ownerOf(k))?.equals(want))return true;await sleep(1500)}return false};

// 1. undelegate (permissionless), sent to the TEE
if ((await ownerOf(ledger))?.equals(DELEGATION)) {
  const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
  const undel = new TransactionInstruction({ programId: VAULT, keys: [sg(admin.publicKey), sgro(admin.publicKey), rw(ledger), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT)], data: anchorDisc('undelegate') });
  await sendAndConfirmTransaction(tee, new Transaction().add(undel), [admin], { commitment: 'confirmed', skipPreflight: true });
  console.log('1. undelegate →', await awaitOwner(ledger, VAULT) ? 'home ✅' : '⚠️ not home');
} else console.log('1. already home');

// 2. make_public
const pub = new TransactionInstruction({ programId: PROGRAM, keys: [sg(admin.publicKey), ro(jackpot), ro(ledger), rw(perm), ro(PERMISSION), ro(VAULT), ro(SystemProgram.programId)], data: Buffer.concat([header(22), Buffer.from([1]), Buffer.from([1])]) });
await sendAndConfirmTransaction(base, new Transaction().add(pub), [admin], { commitment: 'confirmed' });
console.log('2. make_public → permission', (await base.getAccountInfo(perm)) ? 'STILL EXISTS ⚠️' : 'gone (public) ✅');

// 3. re-delegate to the TEE
const b=(tag,prog)=>pda([Buffer.from(tag), ledger.toBuffer()], prog);
const del = new TransactionInstruction({ programId: PROGRAM, keys: [sg(admin.publicKey), rw(jackpot), rw(b('buffer',VAULT)), rw(b('delegation',DELEGATION)), rw(b('delegation-metadata',DELEGATION)), rw(ledger), ro(VAULT), ro(DELEGATION), ro(SystemProgram.programId)], data: Buffer.concat([header(16), Buffer.from([1]), VALIDATOR.toBuffer()]) });
await sendAndConfirmTransaction(base, new Transaction().add(del), [admin], { commitment: 'confirmed' });
console.log('3. re-delegate →', await awaitOwner(ledger, DELEGATION) ? 'delegated ✅' : '⚠️ not delegated');
