// Holds the sheet on target as prices move.
//
//   npx vite-node rebalance.ts              # report only, change nothing
//   npx vite-node rebalance.ts --apply      # rewrite cards.json
//   npx vite-node rebalance.ts --hold       # hold printed prizes unless far off the curve
//
// Runs the balancing tool's own solver rather than a second implementation of it. The previous
// script sampled the engine to find amounts, which was necessary when a card's real RTP was
// emergent — incidental wins landed on top of a planted chance and only a deal could tell you
// the total. Odds are declared now, so RTP is a closed form and the answer is exact rather than
// converged-upon. Sharing the code path is the point: a cron that solves differently from the
// tool is a cron that quietly disagrees with the sheet a person tuned.
//
// Prizes drift off the curve continuously as tokens move, so both halves update: each card's
// amounts are re-fitted to its design curve and rounded, then the pay weights land RTP exactly.
// A player sees the printed prize change, which is the honest signal that what a token is worth
// has changed. `--hold` (solveBalanced) keeps a printed prize until its value slides more than
// ~a rounding step off its rung — for runs where sheet stability matters more than curve fit.

import { readFileSync, writeFileSync } from 'node:fs'
import { solveLadder, solveBalanced } from './src/model/solve.ts'
import { analyse } from './src/model/analytics.ts'
import { validate } from './src/model/validate.ts'
import { backfill, DEFAULT_LADDER, TARGET_RTP, jackpotHitFor, decimalsOf } from './src/model/types.ts'
import type { Card, Design } from './src/model/types.ts'

const CARDS = new URL('./cards.json', import.meta.url)
const DESIGN = new URL('./design.json', import.meta.url)
const PRICES = new URL('../../scripts/prices.json', import.meta.url)

const raw = JSON.parse(readFileSync(PRICES, 'utf8')) as Record<string, unknown>
const prices = Object.fromEntries(
  Object.entries(raw).filter(([, v]) => typeof v === 'number'),
) as Record<string, number>

const fetched = typeof raw._fetched === 'string' ? Date.parse(raw._fetched) : NaN
const ageHours = isFinite(fetched) ? (Date.now() - fetched) / 3_600_000 : Infinity

// Rebalancing against stale prices is worse than not rebalancing: it moves every prize toward a
// market that has already gone somewhere else, and does it with the authority of a cron.
const MAX_PRICE_AGE_HOURS = 6
if (ageHours > MAX_PRICE_AGE_HOURS) {
  console.error(
    `prices are ${isFinite(ageHours) ? `${ageHours.toFixed(1)}h` : 'of unknown age'} old — ` +
    `run scripts/fetch-prices.mjs first (max ${MAX_PRICE_AGE_HOURS}h)`,
  )
  process.exit(1)
}

const cards = backfill(JSON.parse(readFileSync(CARDS, 'utf8')) as Card[])
const design = JSON.parse(readFileSync(DESIGN, 'utf8')) as Design
const apply = process.argv.includes('--apply')
const hold = process.argv.includes('--hold')
const pct = (n: number) => `${(n * 100).toFixed(2)}%`

const next: Card[] = []
let worst = 0

for (const card of cards) {
  const d = { ...DEFAULT_LADDER, ...design[card.id] }
  const before = analyse(card, prices)
  const L = (hold ? solveBalanced : solveLadder)(card, prices, d.min, d.max, d.bend, TARGET_RTP, d.top)
  const solved: Card = {
    ...card,
    // Follows price rather than being carried alongside it. Price is the only field of a card
    // edited by hand — the tool has no control for it — so this is where the two would drift.
    jackpotHitWeight: jackpotHitFor(card.priceLamports),
    pool: card.pool.map((p, i) => ({ ...p, amount: L.amounts[i], weight: L.weights[i] })),
    pays: card.pays.map((p, i) => ({ ...p, weight: L.payWeights[i] })),
  }
  const after = analyse(solved, prices)
  next.push(solved)

  const drift = Math.abs(before.tokenRtp - TARGET_RTP)
  worst = Math.max(worst, drift)
  // old→new per reprinted prize, the new value green when it grew and red when it shrank
  const delta = (p: { token: string; amount: number }, to: number) => {
    const whole = (a: number) => (a / 10 ** decimalsOf(p.token)).toLocaleString()
    const paint = to > p.amount ? '\x1b[32m' : '\x1b[31m'
    return `${p.token} ${whole(p.amount)}→${paint}${whole(to)}\x1b[0m`
  }
  const moved = card.pool
    .map((p, i) => (p.amount === L.amounts[i] ? null : delta(p, L.amounts[i])))
    .filter(Boolean)

  console.log(
    `${card.id.padEnd(9)} RTP ${pct(before.tokenRtp).padStart(7)} → ${pct(after.tokenRtp).padStart(7)}` +
    `   wins 1 in ${(1 / after.winRate).toFixed(1)}` +
    `   top ${Math.round(after.top?.multiple ?? 0)}×` +
    (moved.length ? `   moved ${moved.join(' ')}` : '   unchanged'),
  )
}

console.log(`\nworst drift before this run: ${pct(worst)}`)

// The solver moves weights, and the sheet it started from was edited by hand. Neither is
// trusted: a cron that publishes without re-checking is a cron that can put an invalid card on
// chain at 4am, and `SetCard` refusing it is the good case — the bad one is a rule the chain
// does not enforce, like jackpot chance tracking price, going out unnoticed.
const broken = next.flatMap(c => validate(c).filter(k => !k.ok).map(k => `${c.id}: ${k.label} — ${k.detail}`))
if (broken.length) {
  console.error(`\n${broken.length} check(s) failed:`)
  for (const b of broken) console.error(`  ${b}`)
  process.exit(1)
}
console.log('all checks pass')

if (!apply) {
  console.log('report only — pass --apply to write cards.json')
} else {
  writeFileSync(CARDS, `${JSON.stringify(next, null, 2)}\n`)
  console.log('wrote cards.json — publish with: node scripts/setup-devnet.mjs --cards-only (add --mainnet for the real chain)')
}
