// Headless run of the same model the UI uses, so the numbers can be checked without a browser.
//   node --experimental-strip-types check.ts
import prices from '../../scripts/prices.json' with { type: 'json' }
import { CARDS as SEED } from './src/model/cards.ts'
import { analyse } from './src/model/analytics.ts'
import { validate } from './src/model/validate.ts'
import { TARGET_RTP, TOTAL, whole, backfill } from './src/model/types.ts'

// the saved sheet if there is one, otherwise the built-in conversion of today's cards
let CARDS = SEED
try {
  const mod = await import('./cards.json', { with: { type: 'json' } })
  if (Array.isArray(mod.default) && mod.default.length) CARDS = backfill(mod.default as typeof SEED)
} catch { /* nothing saved yet */ }

const P = Object.fromEntries(
  Object.entries(prices).filter(([, v]) => typeof v === 'number'),
) as Record<string, number>

const pct = (n: number) => `${(n * 100).toFixed(2)}%`
const pad = (s: string, n: number) => s.padStart(n)

console.log(
  pad('card', 16), pad('price', 8), pad('RTP', 8), pad('edge', 8),
  pad('wins', 10), pad('top', 12), pad('odds', 14), pad('rows', 6), 'checks',
)

for (const card of CARDS) {
  const s = analyse(card, P)
  const bad = validate(card).filter(c => !c.ok)
  console.log(
    pad(card.id, 16),
    pad(`${s.priceSol}`, 8),
    pad(pct(s.tokenRtp), 8),
    pad(pct(s.houseEdge), 8),
    pad(s.winRate > 0 ? `1 in ${(1 / s.winRate).toFixed(1)}` : '—', 10),
    pad(s.top ? `${s.top.multiple.toFixed(0)}×` : '—', 12),
    pad(s.top && s.top.p > 0 ? `1 in ${Math.round(1 / s.top.p).toLocaleString()}` : '—', 14),
    pad(`${s.rows.length}`, 6),
    bad.length ? `FAIL ${bad.map(c => c.label).join('; ')}` : 'pass',
  )
}

console.log(`\ntarget ${pct(TARGET_RTP)} in tokens · weights out of ${TOTAL.toLocaleString()}`)

for (const card of CARDS) {
  const s = analyse(card, P)
  console.log(`\n${card.id} — where the return sits`)
  for (const b of s.bands) {
    if (b.rtp <= 0 && b.p <= 0) continue
    console.log(
      `  ${pad(b.label, 14)}  ${pad(pct(b.rtp), 8)} of price` +
      `  ${pad(b.p > 0 ? `1 in ${Math.round(1 / b.p).toLocaleString()}` : '—', 16)}`,
    )
  }
}
