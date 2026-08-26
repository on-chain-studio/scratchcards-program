// Does the TEE's WebSocket honour ?token= the way its HTTP side does?
//
// The app sees every socket read of an existing account come back null while the same read
// over HTTP answers — which is exactly what an unauthenticated TEE client sees. This asks the
// same question three ways and prints the three answers side by side.
//
// The keypair is ephemeral and never funded: a TEE token costs a signature, nothing else.

import { Keypair, PublicKey } from '@solana/web3.js';
import { WebSocket } from 'ws';
import { teeToken } from './tee-auth.mjs';

const TEE = 'https://devnet-tee.magicblock.app';
const GAME = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');

const config = PublicKey.findProgramAddressSync([Buffer.from('config')], GAME)[0];
const jackpot = PublicKey.findProgramAddressSync(
  [Buffer.from('ledger'), PublicKey.findProgramAddressSync([Buffer.from('jackpot')], GAME)[0].toBuffer()],
  VAULT,
)[0];

const kp = Keypair.generate();
const token = await teeToken(kp);
console.log(`token ${token.slice(0, 24)}…\n`);

const body = (account) => JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
  params: [account.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
});

const summarize = (reply) => {
  if (reply?.error) return `ERROR ${JSON.stringify(reply.error)}`;
  const v = reply?.result?.value;
  if (v === null || v === undefined) return 'value null (invisible)';
  const bytes = v.data?.[0] ? Buffer.from(v.data[0], 'base64').length : 0;
  return `${bytes}B  owner ${String(v.owner).slice(0, 12)}`;
};

const overHttp = async (url, account) =>
  (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(account) })).json();

const overWs = (url, account, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers });
  const timer = setTimeout(() => { resolve({ error: 'timeout (10s)' }); ws.terminate(); }, 10_000);
  ws.on('open', () => ws.send(body(account)));
  ws.on('message', (m) => { clearTimeout(timer); resolve(JSON.parse(m.toString())); ws.close(); });
  ws.on('error', (e) => { clearTimeout(timer); resolve({ error: String(e.message ?? e) }); });
});

for (const [label, account] of [['config', config], ['jackpot ledger', jackpot]]) {
  console.log(`── ${label} ──`);
  console.log('http  +token       :', summarize(await overHttp(`${TEE}?token=${token}`, account)));
  console.log('http  no token     :', summarize(await overHttp(TEE, account)));
  console.log('ws    ?token= query:', summarize(await overWs(`wss://devnet-tee.magicblock.app?token=${token}`, account)));
  console.log('ws    no token     :', summarize(await overWs('wss://devnet-tee.magicblock.app', account)));
  console.log('ws    Bearer header:', summarize(await overWs('wss://devnet-tee.magicblock.app', account, { Authorization: `Bearer ${token}` })));
  console.log();
}
