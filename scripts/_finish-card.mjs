// Finishes a card left mid-flow: reveal, wait for the VRF, collect.
//
//   node scripts/_finish-card.mjs            on the public ER
//   ROLLUP=tee node scripts/_finish-card.mjs on the private TEE
//
// For a card a harness bought but never carried through — a confirmation that timed out on a
// transaction that actually landed leaves exactly this state.

import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import crypto from 'crypto';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { decodeCard, decodeLedger } from './accounts.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const PUBLIC_ER = 'https://devnet.magicblock.app';
const ROLLUP = process.env.ROLLUP === 'tee' ? TEE : PUBLIC_ER;
const PRIVATE = ROLLUP === TEE;

const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const MAGIC_CONTEXT = new PublicKey('MagicContext1111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const VRF_PROGRAM = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_EPHEMERAL_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const SLOT_HASHES = new PublicKey('SysvarS1otHashes111111111111111111111111111');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));
const user = admin.publicKey;

const pda = (s, p = PROGRAM) => PublicKey.findProgramAddressSync(s, p)[0];
const house = pda([Buffer.from('house')]);
const jackpot = pda([Buffer.from('jackpot')]);
const config = pda([Buffer.from('config')]);
const analytics = pda([Buffer.from('analytics')]);
const identity = pda([Buffer.from('identity')]);
const card = pda([Buffer.from('card'), user.toBuffer()]);
const ledger = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const receipt = pda([Buffer.from('receipt'), PROGRAM.toBuffer(), user.toBuffer()], VAULT);
const vaultAuthority = pda([], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

const conn = new Connection(
  PRIVATE ? `${ROLLUP}?token=${await teeToken(admin)}` : ROLLUP, 'confirmed');

const send = (ixs) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [admin],
  { commitment: 'confirmed', skipPreflight: true });

const readCard = async () => {
  const i = await conn.getAccountInfo(card);
  return i && decodeCard(i.data);
};
const solOf = async (o) => {
  const i = await conn.getAccountInfo(ledger(o));
  return i ? Number(decodeLedger(i.data).sol) : 0;
};

console.log('rollup', ROLLUP, PRIVATE ? '(private)' : '(public)');

let c = await readCard();
if (!c) { console.log('no card to finish'); process.exit(0); }
console.log(`card: status ${c.status}, cardId ${c.cardId}`);

if (c.status === 'bought') {
  await send([new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      ro(user), rw(house), rw(card), ro(identity), rw(VRF_EPHEMERAL_QUEUE),
      ro(SLOT_HASHES), ro(SystemProgram.programId), ro(VRF_PROGRAM),
    ],
    data: header(28),
  })]);
  console.log('  ✅ reveal requested');
}

for (let i = 0; i < 40 && (await readCard())?.status !== 'revealed'; i++) {
  await new Promise((r) => setTimeout(r, 750));
}
c = await readCard();
if (c?.status !== 'revealed') { console.log(`  ❌ seed never arrived (status ${c?.status})`); process.exit(1); }
console.log(`  ✅ VRF answered — seed ${Buffer.from(c.seed).toString('hex').slice(0, 16)}…`);

const before = await solOf(user);
await send([
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      ro(user), ro(config), rw(house), rw(card), rw(receipt),
      rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT),
      ro(jackpot), ro(ledger(jackpot)),
      sgro(user), rw(ledger(house)), rw(MAGIC_CONTEXT),
    ],
    data: header(25),
  }),
  new TransactionInstruction({
    programId: VAULT,
    keys: [
      rw(receipt), ro(house), sgro(user), ro(PROGRAM), ro(vaultAuthority),
      rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), rw(MAGIC_CONTEXT),
      rw(ledger(user)), rw(ledger(house)), rw(ledger(jackpot)),
      rw(house), rw(card), rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), rw(analytics),
    ],
    data: disc('settle_receipt'),
  }),
]);
const after = await solOf(user);
console.log(`  ✅ collected — ledger ${(before / 1e9).toFixed(6)} → ${(after / 1e9).toFixed(6)}`);
console.log(`  card now: ${(await readCard()) ? 'still there' : 'closed'}`);
process.exit(0);
