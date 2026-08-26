import {
  Card, TOTAL, MAX_POOL, MAX_BLOCKS, MAX_PAYS, MAX_TIERS, MAX_CELLS,
  CELL_PAYLOAD_MAX, MARKED, popcount, cellsOf, bodyLen, cellCount, disjoint,
  jackpotHitFor, JACKPOT_SHARE,
} from './types'

export interface Check {
  ok: boolean
  label: string
  detail: string
}

/**
 * Every rule `SetCard` would enforce on chain, so a sheet can't be tuned into an invalid one —
 * plus the one rule the chain does not know about, which is that jackpot chance tracks price.
 * That one is house policy rather than program logic, and a policy nothing checks is a policy
 * that lasts until the next person edits the field.
 */
export function validate(card: Card): Check[] {
  const out: Check[] = []
  const add = (ok: boolean, label: string, detail: string) => out.push({ ok, label, detail })

  const paySum = card.pays.reduce((n, p) => n + p.weight, 0)
  const poolSum = card.pool.reduce((n, p) => n + p.weight, 0)
  const tierSum = card.tiers.reduce((n, t) => n + t.weight, 0)
  const body = bodyLen(card)

  if (card.roll === 'exclusive') {
    const miss = ((TOTAL - paySum) / TOTAL) * 100
    add(paySum <= TOTAL, 'Σ pay weight ≤ 2³²',
      paySum <= TOTAL
        ? `${paySum.toLocaleString()} of ${TOTAL.toLocaleString()} — miss ${miss.toFixed(2)}%`
        : `${paySum.toLocaleString()} — overcommitted, later entries unreachable`)
  } else {
    const over = card.pays.filter(p => p.weight > TOTAL)
    add(over.length === 0, 'each weight ≤ 2³²',
      over.length ? `${over.length} entries over` : `${card.pays.length} entries roll on their own`)
    const ok = disjoint(card.pays.map(p => p.scope))
    add(ok, 'independent scopes are disjoint',
      ok ? 'no entry can complete another'
         : 'overlapping scopes cannot roll independently and stay exact')
  }

  add(poolSum === TOTAL, 'Σ pool weight = 2³²',
    poolSum === TOTAL ? 'exact' : `${poolSum.toLocaleString()}, off by ${(poolSum - TOTAL).toLocaleString()}`)

  const wantHit = jackpotHitFor(card.priceLamports)
  const perSol = (card.jackpotHitWeight / TOTAL) / (card.priceLamports / 1e9)
  add(card.jackpotHitWeight === wantHit,
    `jackpot chance = ${(JACKPOT_SHARE * 100).toFixed(0)}% per SOL`,
    card.jackpotHitWeight === wantHit
      ? `${((wantHit / TOTAL) * 100).toFixed(4)}% at ${(card.priceLamports / 1e9)} SOL`
      : `${(perSol * 100).toFixed(3)}% per SOL — should be ${wantHit.toLocaleString()}, ` +
        `is ${card.jackpotHitWeight.toLocaleString()}`)

  add(card.jackpotHitWeight + card.jackpotNearWeight <= TOTAL, 'jackpot bands fit 2³²',
    `hit and near are exclusive bands out of the same draw`)

  add(tierSum <= TOTAL, 'Σ tier weight ≤ 2³²',
    card.tiers.length ? `${((tierSum / TOTAL) * 100).toFixed(2)}% carry a multiplier` : 'no multiplier tiers')

  add(card.pool.length >= 1 && card.pool.length <= MAX_POOL,
    `pool ≤ ${MAX_POOL}`, `${card.pool.length} tokens`)
  add(card.blocks.length >= 1 && card.blocks.length <= MAX_BLOCKS,
    `blocks ≤ ${MAX_BLOCKS}`, `${card.blocks.length} blocks`)
  add(card.pays.length >= 1 && card.pays.length <= MAX_PAYS,
    `pays ≤ ${MAX_PAYS}`, `${card.pays.length} entries`)
  add(card.tiers.length <= MAX_TIERS, `tiers ≤ ${MAX_TIERS}`, `${card.tiers.length}`)

  add(cellCount(card) <= MAX_CELLS, `cells ≤ ${MAX_CELLS}`,
    `${cellCount(card)} cells, ${body} in the body`)

  const jacks = card.blocks.filter(b => b.role === 'jackpot')
  add(jacks.length === 1 && card.blocks[card.blocks.length - 1].role === 'jackpot',
    'one jackpot block, last',
    jacks.length === 1 ? 'body is a prefix' : `${jacks.length} jackpot blocks`)

  const badMin = card.pays.filter(p => p.min < 1 || p.min > popcount(p.scope))
  add(badMin.length === 0, '1 ≤ min ≤ popcount(scope)',
    badMin.length ? `${badMin.length} entries out of range` : 'all entries payable')

  const outOfBody = card.pays.filter(p => cellsOf(p.scope).some(c => c >= body))
  add(outOfBody.length === 0, 'scope inside the body',
    outOfBody.length ? `${outOfBody.length} entries reach the jackpot row` : 'no entry touches the jackpot row')

  const badRange = card.blocks.filter(b => b.role === 'number' && (b.a > b.b || b.b > CELL_PAYLOAD_MAX))
  add(badRange.length === 0, 'number ranges fit 12 bits',
    badRange.length ? `${badRange.length} bad ranges` : 'ok')

  add(poolSum > 0 && card.pool.some(p => p.weight > 0), 'pool has a drawable token',
    card.pool.filter(p => p.weight > 0).length + ' with weight')

  const needsMark = card.pays.some(p => p.flags & MARKED)
  const hasMark = card.blocks.some(b => b.role === 'mark')
  add(!needsMark || hasMark, 'MARKED pays have a mark block',
    needsMark ? (hasMark ? 'present' : 'missing') : 'not used')

  if (card.mode === 'compare') {
    const [h, m, prize] = card.modeArgs
    const ok = [h, m, prize].every(i => card.blocks[i] !== undefined) &&
      card.blocks[h]?.role === 'number' && card.blocks[m]?.role === 'number' &&
      card.blocks[prize]?.role === 'plate' &&
      card.blocks[h]?.count === card.blocks[m]?.count &&
      card.blocks[m]?.count === card.blocks[prize]?.count
    add(ok, 'compare blocks line up',
      ok ? `${card.blocks[h].count} duels` : 'block roles or counts disagree')
  }

  return out
}
