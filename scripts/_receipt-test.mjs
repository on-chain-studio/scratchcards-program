// Three mechanics the receipt design rests on:
//   ix0  game CPIs the vault → vault creates an ephemeral account it OWNS
//   ix1  vault (top-level) writes to that account in a later instruction
//   ix2  the sponsor (the game's house, NOT the vault) closes it
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const house = PublicKey.findProgramAddressSync([Buffer.from('house')], PROGRAM)[0];
const nonce = BigInt(Date.now());
const receipt = PublicKey.findProgramAddressSync(
  [Buffer.from('receipt'), house.toBuffer(), u64(nonce)], VAULT)[0];

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });

const conn = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
const terms = Buffer.from([1, 2, 3, 4]);

async function step(label, ixs) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(admin);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`  ✅ ${label}`);
    return true;
  } catch (e) {
    const m = String(e.message || e);
    console.log(`  ❌ ${label}\n     ${(m.match(/Status: \((.*?)\)/) || [, m.split('\n')[0]])[1]}`);
    return false;
  }
}

async function show(when) {
  const i = await conn.getAccountInfo(receipt);
  console.log(`     receipt ${when}: ${i ? `owner ${i.owner.toBase58().slice(0,8)}… ${i.data.length}B data[0]=${i.data[0]}` : 'absent'}`);
}

console.log('receipt', receipt.toBase58(), '\n');

// ix0 — game CPIs vault::create_receipt; vault creates the ephemeral account and owns it
const create = new TransactionInstruction({
  programId: PROGRAM,
  keys: [sg(house), rw(receipt), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT)],
  data: Buffer.concat([header(22), u64(nonce), u32(terms.length), terms]),
});
// house must not be marked signer by us — the game signs for it via invoke_signed
create.keys[0] = rw(house);

if (await step('ix0  game → vault CPI creates a vault-owned ephemeral receipt', [create])) {
  await show('after ix0');
  // ix1 — vault, top-level, writes to it
  const mark = new TransactionInstruction({
    programId: VAULT, keys: [rw(receipt)], data: disc('mark_receipt'),
  });
  if (await step('ix1  vault (top-level) writes to the receipt', [mark])) await show('after ix1');
  // ix2 — sponsor (house, via the game) closes it
  const close = new TransactionInstruction({
    programId: PROGRAM,
    keys: [rw(house), rw(receipt), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM)],
    data: header(23),
  });
  if (await step('ix2  sponsor closes an account the vault owns', [close])) await show('after ix2');
}
