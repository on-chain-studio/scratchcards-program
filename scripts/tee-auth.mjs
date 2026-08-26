// Signed-challenge auth for the TEE (private rollup). Every RPC there needs ?token=;
// without it reads come back empty and writes fail with 401.
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { TEE as HOST } from './net.mjs';

export async function teeToken(keypair) {
  const pubkey = keypair.publicKey.toBase58();
  const c = await (await fetch(`${HOST}/auth/challenge?pubkey=${pubkey}`)).json();
  const sig = nacl.sign.detached(new TextEncoder().encode(c.challenge), keypair.secretKey);
  const r = await fetch(`${HOST}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey, challenge: c.challenge, signature: bs58.encode(sig) }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`TEE login failed: ${JSON.stringify(j)}`);
  return j.token;
}

export const teeEndpoint = async (keypair) => `${HOST}?token=${await teeToken(keypair)}`;
