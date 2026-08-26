// End to end: a Token-2022 mint through the vault — create, deposit (checked transfer with the
// trailing mint), verify the ledger credit, withdraw back, verify the wallet. Devnet.
import fs from 'fs';
import crypto from 'crypto';
import { ADMIN_PATH, BASENET, TEE } from './net.mjs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';

const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const PERMISSION = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const base = new Connection(BASENET, 'confirmed');
const pda = (s, p) => PublicKey.findProgramAddressSync(s, p)[0];
const ledger = pda([Buffer.from('ledger'), admin.publicKey.toBuffer()], VAULT);
const reserve = pda([Buffer.from('vault')], VAULT);
const perm = pda([Buffer.from('permission:'), ledger.toBuffer()], PERMISSION);
const ataOf = (owner, mint) => pda([owner.toBuffer(), T22.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const sg = (k) => ({ pubkey: k, isSigner: true, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);
const send = (ixs, signers = [admin]) =>
  sendAndConfirmTransaction(base, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });

// 1 ── a fresh Token-2022 mint, 6 decimals, admin authority
const mintKp = Keypair.generate();
const AMOUNT = 5_000_000; // 5 whole
await send([
  SystemProgram.createAccount({
    fromPubkey: admin.publicKey, newAccountPubkey: mintKp.publicKey,
    lamports: await base.getMinimumBalanceForRentExemption(82), space: 82, programId: T22,
  }),
  new TransactionInstruction({ // InitializeMint2 (20): decimals, authority, no freeze
    programId: T22,
    keys: [rw(mintKp.publicKey)],
    data: Buffer.concat([Buffer.from([20, 6]), admin.publicKey.toBuffer(), Buffer.from([0])]),
  }),
  new TransactionInstruction({ // ATA create idempotent for admin, T22
    programId: ATA_PROGRAM,
    keys: [sg(admin.publicKey), rw(ataOf(admin.publicKey, mintKp.publicKey)), ro(admin.publicKey),
           ro(mintKp.publicKey), ro(SystemProgram.programId), ro(T22)],
    data: Buffer.from([1]),
  }),
  new TransactionInstruction({ // MintTo (7)
    programId: T22,
    keys: [rw(mintKp.publicKey), rw(ataOf(admin.publicKey, mintKp.publicKey)), sgro(admin.publicKey)],
    data: Buffer.concat([Buffer.from([7]), u64(AMOUNT)]),
  }),
], [admin, mintKp]);
console.log('1. T22 mint', mintKp.publicKey.toBase58(), '— minted', AMOUNT);

// 2 ── ledger home if delegated
if ((await base.getAccountInfo(ledger))?.owner.equals(DELEGATION)) {
  const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
  await sendAndConfirmTransaction(tee, new Transaction().add(new TransactionInstruction({
    programId: VAULT,
    keys: [sg(admin.publicKey), sgro(admin.publicKey), rw(ledger), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT), rw(EPHEMERAL_VAULT)],
    data: disc('undelegate'),
  })), [admin], { commitment: 'confirmed', skipPreflight: true });
  for (let i = 0; i < 40; i++) {
    if ((await base.getAccountInfo(ledger))?.owner.equals(VAULT)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log('2. ledger home');
}

// 3 ── deposit: T22 program + trailing mint
await send([
  new TransactionInstruction({ // reserve ATA (T22) idempotent
    programId: ATA_PROGRAM,
    keys: [sg(admin.publicKey), rw(ataOf(reserve, mintKp.publicKey)), ro(reserve),
           ro(mintKp.publicKey), ro(SystemProgram.programId), ro(T22)],
    data: Buffer.from([1]),
  }),
  new TransactionInstruction({
    programId: VAULT,
    keys: [sg(admin.publicKey), rw(ledger), rw(perm), ro(PERMISSION), rw(reserve),
           rw(ataOf(reserve, mintKp.publicKey)), rw(ataOf(admin.publicKey, mintKp.publicKey)),
           ro(T22), ro(SystemProgram.programId), ro(mintKp.publicKey)],
    data: Buffer.concat([disc('deposit'), mintKp.publicKey.toBuffer(), u64(AMOUNT), Buffer.from([0]), Buffer.from([0])]),
  }),
]);
const l = decodeLedger((await base.getAccountInfo(ledger)).data);
console.log('3. deposited — ledger holds', l.balances[mintKp.publicKey.toBase58()] ?? 0n, 'of the mint');

// 4 ── withdraw back
await send([new TransactionInstruction({
  programId: VAULT,
  keys: [sg(admin.publicKey), rw(ledger), rw(reserve),
         rw(ataOf(reserve, mintKp.publicKey)), rw(ataOf(admin.publicKey, mintKp.publicKey)),
         ro(T22), ro(SystemProgram.programId), ro(mintKp.publicKey)],
  data: Buffer.concat([disc('withdraw'), mintKp.publicKey.toBuffer(), u64(AMOUNT)]),
})]);
const back = await base.getTokenAccountBalance(ataOf(admin.publicKey, mintKp.publicKey));
console.log('4. withdrawn — wallet holds', back.value.amount, '(expected', AMOUNT + ')');
console.log(back.value.amount === String(AMOUNT) ? '✅ Token-2022 round trip through the vault' : '❌ mismatch');
