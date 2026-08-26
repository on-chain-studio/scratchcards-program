import fs from 'fs';
import { ADMIN_PATH } from './net.mjs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { decodeLedger } from './accounts.mjs';
import { teeToken } from './tee-auth.mjs';

const GAME = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const DELEGATION = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const PLAYER = new PublicKey('3ALoqzcc3XGWR2xEgHobodx9NyMPJG6MFVjK95WRo53R');

const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(
  fs.readFileSync(ADMIN_PATH))));

const base = new Connection('https://rpc.magicblock.app/devnet', 'confirmed');
const tee = new Connection(`https://devnet-tee.magicblock.app?token=${await teeToken(admin)}`, 'confirmed');

const ledgerOf = (o) => PublicKey.findProgramAddressSync([Buffer.from('ledger'), o.toBuffer()], VAULT)[0];
const treasury = (s) => PublicKey.findProgramAddressSync([Buffer.from(s)], GAME)[0];
const record = (a) => PublicKey.findProgramAddressSync([Buffer.from('delegation'), a.toBuffer()], DELEGATION)[0];

async function show(label, addr) {
  const b = await base.getAccountInfo(addr);
  const delegated = b?.owner.equals(DELEGATION);
  let validator = '—';
  if (delegated) {
    const r = await base.getAccountInfo(record(addr));
    if (r) validator = new PublicKey(r.data.subarray(8, 40)).toBase58();
  }
  const t = await tee.getAccountInfo(addr).catch(() => null);
  console.log(
    `${label.padEnd(16)} ${addr.toBase58()}\n` +
    `   basenet ${(b ? b.owner.toBase58() : 'missing').slice(0, 12)}  delegated ${!!delegated}  validator ${validator}` +
    `${b && decodeLedger(b.data) ? '  sol ' + decodeLedger(b.data).sol : ''}  lamports ${b?.lamports ?? 0}\n` +
    `   rollup  ${t ? t.owner.toBase58().slice(0, 12) + '  ' + t.data.length + 'B' + (decodeLedger(t.data) ? '  sol ' + decodeLedger(t.data).sol : '') : 'not visible'}`,
  );
}

await show('house treasury', treasury('house'));
await show('house ledger', ledgerOf(treasury('house')));
await show('jackpot ledger', ledgerOf(treasury('jackpot')));
await show('player ledger', ledgerOf(PLAYER));
await show('config', PublicKey.findProgramAddressSync([Buffer.from('config')], GAME)[0]);
