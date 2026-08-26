// Can a wallet that is a member of nothing read the jackpot ledger on the TEE?
//
// The jackpot ledger deliberately has no permission so the pot is public. The app now reads it
// on every balance refresh, inside TeeAuth.authenticated — so if that read fails in a way that
// looks like a rejected token, the wrapper re-mints and the player gets a signature prompt.
//
// The keypair here is ephemeral and never funded: a TEE token costs a signature, nothing else.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';

const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const GAME = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const TEE = 'https://devnet-tee.magicblock.app';

const stranger = Keypair.generate();
console.log(`stranger ${stranger.publicKey.toBase58()} (never funded, never a member)`);

const token = await teeToken(stranger);
console.log(`token    ${token.slice(0, 24)}…\n`);

const conn = new Connection(`${TEE}?token=${token}`, 'confirmed');
const ledgerOf = (o) => PublicKey.findProgramAddressSync([Buffer.from('ledger'), o.toBuffer()], VAULT)[0];

for (const [label, addr] of [
  ['jackpot ledger (no permission)', ledgerOf(PublicKey.findProgramAddressSync([Buffer.from('jackpot')], GAME)[0])],
  ['house ledger   (permissioned)', ledgerOf(PublicKey.findProgramAddressSync([Buffer.from('house')], GAME)[0])],
  ['config         (not delegated)', PublicKey.findProgramAddressSync([Buffer.from('config')], GAME)[0]],
]) {
  try {
    const i = await conn.getAccountInfo(addr);
    console.log(`${label}  ${i ? `${i.data.length}B  owner ${i.owner.toBase58().slice(0, 12)}` : 'null (invisible)'}`);
  } catch (e) {
    console.log(`${label}  ERROR ${String(e).split('\n')[0]}`);
  }
}
