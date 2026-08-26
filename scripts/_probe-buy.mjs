// Bisects the InvalidWritableAccount in the buy transaction. RequestPurchase alone is known
// to land (ephemeral receipt creation works), so this sends the full purchase+settle pair
// twice: as the play script does, then with the VRF queue read-only. A sanitize failure has
// no logs; an execution failure does — which side the queue-readonly variant fails on says
// whether the queue's writability is what the validator refuses.
import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, SystemProgram,
} from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const MAGIC_PROGRAM = new PublicKey('Magic11111111111111111111111111111111111111');
const EPHEMERAL_VAULT = new PublicKey('MagicVau1t999999999999999999999999999999999');
const VRF_PROGRAM = new PublicKey('Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz');
const VRF_QUEUE = new PublicKey('5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc');
const SLOT_HASHES = new PublicKey('SysvarS1otHashes111111111111111111111111111');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const house = pda([Buffer.from('house')]);
const jackpot = pda([Buffer.from('jackpot')]);
const config = pda([Buffer.from('config')]);
const identity = pda([Buffer.from('identity')]);
const card = pda([Buffer.from('card'), admin.publicKey.toBuffer()]);
const ledger = (o) => pda([Buffer.from('ledger'), o.toBuffer()], VAULT);
const receipt = pda([Buffer.from('receipt'), house.toBuffer(), admin.publicKey.toBuffer()], VAULT);

const ro = (k) => ({ pubkey: k, isSigner: false, isWritable: false });
const rw = (k) => ({ pubkey: k, isSigner: false, isWritable: true });
const sgro = (k) => ({ pubkey: k, isSigner: true, isWritable: false });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const header = (v) => { const b = Buffer.alloc(8); b[0] = v; return b; };
import crypto from 'crypto';
const disc = (n) => crypto.createHash('sha256').update('global:' + n).digest().subarray(0, 8);

const tee = new Connection(`${TEE}?token=${await teeToken(admin)}`, 'confirmed');
const logsBySig = new Map();
await tee.onLogs('all', (l) => logsBySig.set(l.signature, l.logs ?? []), 'confirmed');

for (const [name, key] of Object.entries({
  'player ledger': ledger(admin.publicKey), 'house ledger': ledger(house),
  'jackpot ledger': ledger(jackpot),
})) {
  try {
    const i = await tee.getAccountInfo(key);
    console.log(name.padEnd(15), i ? `${i.data.length} B, owner ${i.owner.toBase58().slice(0, 8)}…` : 'absent on TEE');
  } catch (e) { console.log(name.padEnd(15), 'read failed:', String(e).split('\n')[0]); }
}

const buyPair = (queueMeta) => [
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      sgro(admin.publicKey), ro(admin.publicKey), ro(config), rw(house), rw(receipt),
      rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM), ro(VAULT), ro(jackpot),
    ],
    data: Buffer.concat([header(24), u64(0)]),
  }),
  new TransactionInstruction({
    programId: VAULT,
    keys: [
      rw(receipt), ro(house), sgro(admin.publicKey), ro(PROGRAM),
      queueMeta.player(ledger(admin.publicKey)), queueMeta.hl(ledger(house)),
      queueMeta.jl(ledger(jackpot)),
      ro(config), rw(house), queueMeta.card(card),
      rw(EPHEMERAL_VAULT), ro(MAGIC_PROGRAM),
      ro(identity), queueMeta.q(VRF_QUEUE), ro(SLOT_HASHES),
      ro(SystemProgram.programId), ro(VRF_PROGRAM),
    ],
    data: disc('settle_receipt'),
  }),
];

const all = { player: rw, hl: rw, jl: rw, card: rw, q: rw };
const variants = [
  ['all writable (as shipped)', { ...all }],
  ['card read-only', { ...all, card: ro }],
  ['jackpot ledger read-only', { ...all, jl: ro }],
  ['house ledger read-only', { ...all, hl: ro }],
  ['player ledger read-only', { ...all, player: ro }],
  ['queue read-only', { ...all, q: ro }],
];
for (const [name, queueMeta] of variants) {
  try {
    const sig = await sendAndConfirmTransaction(tee, new Transaction().add(...buyPair(queueMeta)), [admin],
      { commitment: 'confirmed', skipPreflight: true });
    console.log(`${name}: LANDED ${sig}`);
    break;
  } catch (e) {
    console.log(`${name}: FAILED — ${String(e).split('\n').filter(Boolean)[1] ?? String(e).split('\n')[0]}`);
    const sig = String(e).match(/Transaction ([1-9A-HJ-NP-Za-km-z]{60,}) /)?.[1];
    await new Promise((r) => setTimeout(r, 2000));
    const logs = sig && logsBySig.get(sig);
    if (logs?.length) for (const l of logs.slice(-15)) console.log('   ', l);
    else console.log('    (no logs — failed before execution)');
  }
}
process.exit(0);
