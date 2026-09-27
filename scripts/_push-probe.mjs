// Does the devnet TEE deliver accountSubscribe notifications for real delegated accounts?
// Subscribes over genuine WSS to the test player's ledger and card PDAs, then runs one card
// play; concurrent HTTP polling is the ground truth for when each change became visible.
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Keypair, PublicKey } from '@solana/web3.js';
import { teeToken } from './tee-auth.mjs';
import { ADMIN_PATH } from './net.mjs';
import WebSocket from 'ws';

const TEE = 'https://devnet-tee.magicblock.app';
const PROGRAM = new PublicKey('GURqYrHYwoUNRLizD2sgRPFgwaV81C8HHm615HK9vtMC');
const VAULT = new PublicKey('VAULTrDSUBZ8AXL2kGVYE8eKAn7tgWXRPAevNGUsyTV');
const pda = (seeds, prog = PROGRAM) => PublicKey.findProgramAddressSync(seeds, prog)[0];

const player = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_PATH))));
const ledger = pda([Buffer.from('ledger'), player.publicKey.toBuffer()], VAULT).toBase58();
const card = pda([Buffer.from('card'), player.publicKey.toBuffer()]).toBase58();
const token = await teeToken(player);
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

// ── WS side ──
const ws = new WebSocket(`wss://devnet-tee.magicblock.app?token=${token}`);
const subs = {};   // ws sub id -> name
await new Promise((res) => ws.on('open', res));
let nextId = 1;
for (const [name, acct] of [['ledger', ledger], ['card', card]]) {
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe',
    params: [acct, { encoding: 'base64', commitment: 'confirmed' }] }));
  subs['pending' + id] = name;
}
ws.on('message', (m) => {
  const j = JSON.parse(m.toString());
  if (j.id) { subs[j.result] = subs['pending' + j.id]; console.log(`${ts()} WS subscribed ${subs['pending' + j.id]} (sub ${j.result})`); }
  else if (j.method === 'accountNotification') {
    const name = subs[j.params.subscription] ?? '?';
    const v = j.params.result?.value;
    const h = v?.data?.[0] ? crypto.createHash('sha256').update(v.data[0]).digest('hex').slice(0, 8) : 'nodata';
    console.log(`${ts()} WS PUSH ${name}: lamports=${v?.lamports} data#${h}`);
  } else console.log(`${ts()} WS other: ${m.toString().slice(0, 120)}`);
});
ws.on('error', (e) => console.log(`${ts()} WS error ${e.message}`));

// ── HTTP poll side (ground truth) ──
const last = {};
async function poll(name, acct) {
  const r = await fetch(`${TEE}?token=${token}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [acct, { encoding: 'base64', commitment: 'confirmed' }] }) });
  const v = (await r.json()).result?.value;
  const h = v ? crypto.createHash('sha256').update((v.data?.[0] ?? '') + v.lamports).digest('hex').slice(0, 8) : 'absent';
  if (last[name] !== h) {
    if (last[name] !== undefined) console.log(`${ts()} HTTP CHANGE ${name}: ${last[name]} -> ${h} lamports=${v?.lamports ?? 0}`);
    else console.log(`${ts()} HTTP baseline ${name}: ${h}`);
    last[name] = h;
  }
}
const pollTimer = setInterval(() => { poll('ledger', ledger); poll('card', card); }, 150);

// ── trigger: one card ──
console.log(`${ts()} starting play (1 card, TEE)...`);
const play = spawn('node', ['scripts/play-devnet.mjs', '1'], { env: { ...process.env, ROLLUP: 'tee' } });
play.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').map(l => l && `   [play] ${l}`).filter(Boolean).join('\n') + '\n'));
play.stderr.on('data', (d) => process.stdout.write(`   [play!] ${d}`));
play.on('exit', (c) => {
  console.log(`${ts()} play exited (${c}) — listening 10s more for stragglers`);
  setTimeout(() => { clearInterval(pollTimer); ws.close(); process.exit(0); }, 10_000);
});
setTimeout(() => { console.log(`${ts()} TIMEOUT`); process.exit(1); }, 150_000);
