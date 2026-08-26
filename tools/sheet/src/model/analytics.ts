import {
  Card, TOTAL, LINEAR, JACKPOT_SHARE, whole, duelsOf,
} from './types'
import { scopeName } from './cards'

export type Prices = Record<string, number>

export interface LadderRow {
  key: string
  payIndex: number
  poolIndex: number
  tierIndex: number
  label: string
  token: string
  units: number
  amount: number
  usd: number
  multiple: number
  /** expected occurrences per card — a probability for `count`, a rate for `compare` */
  p: number
  /** share of the card price returned by this row */
  rtp: number
}

export interface Band {
  label: string
  lo: number
  hi: number
  rtp: number
  p: number
}

export interface Prize {
  key: string
  token: string
  amount: number
  usd: number
  multiple: number
  /** combined chance of winning exactly this prize, from every outcome that can pay it */
  p: number
  rtp: number
  ways: number
}

/**
 * The ladder as a player would read it: one row per distinct prize, not one per
 * (outcome × token × multiplier). Several outcomes can pay the same amount — a ×2 line on a
 * small token and a ×1 line on a bigger one — and the player only sees the amount.
 */
export function prizeList(rows: LadderRow[]): Prize[] {
  const by = new Map<string, Prize>()
  for (const r of rows) {
    if (r.p <= 0) continue
    const key = `${r.token}:${r.units}`
    const got = by.get(key)
    if (got) {
      got.p += r.p
      got.rtp += r.rtp
      got.ways++
    } else {
      by.set(key, {
        key, token: r.token, amount: r.amount, usd: r.usd,
        multiple: r.multiple, p: r.p, rtp: r.rtp, ways: 1,
      })
    }
  }
  return [...by.values()].sort((x, y) => y.usd - x.usd)
}

export interface Summary {
  priceSol: number
  priceUsd: number
  duels: number
  paySum: number
  poolSum: number
  tierSum: number
  multRate: number
  winRate: number
  expectedWins: number
  tokenRtp: number
  jackpotShare: number
  houseEdge: number
  rows: LadderRow[]
  prizes: Prize[]
  bands: Band[]
  /**
   * The dearest prize, and how often it lands *by any route*. Several outcomes can pay the same
   * amount — Straight's three rows all pay one plate — so the chance of winning it is their sum,
   * not any single row's.
   */
  top: Prize | null
  maxCardUsd: number
  missingPrices: string[]
}

const BANDS: [string, number, number][] = [
  ['under 1×', 0, 1],
  ['1 – 5×', 1, 5],
  ['5 – 50×', 5, 50],
  ['50 – 500×', 50, 500],
  ['500 – 5,000×', 500, 5_000],
  ['5,000×+', 5_000, Infinity],
]

export function analyse(card: Card, prices: Prices): Summary {
  const sol = prices.SOL ?? 0
  const priceSol = card.priceLamports / 1e9
  const priceUsd = priceSol * sol

  const paySum = card.pays.reduce((n, p) => n + p.weight, 0)
  const poolSum = card.pool.reduce((n, p) => n + p.weight, 0)
  const tierSum = card.tiers.reduce((n, t) => n + t.weight, 0)

  const duels = duelsOf(card)
  const expectedWins = paySum / TOTAL
  // exclusive: one entry at most, so the weights are a partition. independent: each rolls alone.
  const winRate = card.roll === 'independent'
    ? 1 - card.pays.reduce((n, p) => n * (1 - p.weight / TOTAL), 1)
    : expectedWins

  // the multiplier is its own independent roll; index -1 is "no multiplier"
  const tierOptions = [
    { index: -1, factor: 1, p: 1 - tierSum / TOTAL },
    ...card.tiers.map((t, index) => ({ index, factor: t.factor, p: t.weight / TOTAL })),
  ]

  const missing = new Set<string>()
  const rows: LadderRow[] = []

  card.pays.forEach((pay, payIndex) => {
    const pPay = pay.weight / TOTAL
    if (pPay <= 0) return
    const scale = pay.mult * ((pay.flags & LINEAR) ? pay.min : 1)

    card.pool.forEach((entry, poolIndex) => {
      const pToken = entry.weight / poolSum
      if (pToken <= 0) return
      const price = prices[entry.token]
      if (price === undefined) missing.add(entry.token)

      tierOptions.forEach(tier => {
        if (tier.p <= 0) return
        const units = entry.amount * scale * tier.factor
        const amount = whole(entry.token, units)
        const usd = amount * (price ?? 0)
        const p = pPay * pToken * tier.p
        rows.push({
          key: `${payIndex}:${poolIndex}:${tier.index}`,
          payIndex, poolIndex, tierIndex: tier.index,
          label: scopeName(card, pay),
          token: entry.token,
          units, amount, usd,
          multiple: priceUsd > 0 ? usd / priceUsd : 0,
          p,
          rtp: priceUsd > 0 ? (p * usd) / priceUsd : 0,
        })
      })
    })
  })

  rows.sort((a, b) => b.usd - a.usd)

  const tokenRtp = rows.reduce((n, r) => n + r.rtp, 0)
  const bands = BANDS.map(([label, lo, hi]) => {
    const inBand = rows.filter(r => r.multiple >= lo && r.multiple < hi)
    return {
      label, lo, hi,
      rtp: inBand.reduce((n, r) => n + r.rtp, 0),
      p: inBand.reduce((n, r) => n + r.p, 0),
    }
  })

  const prizes = prizeList(rows)
  const top = prizes[0] ?? null

  return {
    priceSol, priceUsd, duels,
    paySum, poolSum, tierSum,
    multRate: tierSum / TOTAL,
    winRate, expectedWins,
    tokenRtp,
    jackpotShare: JACKPOT_SHARE,
    houseEdge: 1 - tokenRtp - JACKPOT_SHARE,
    rows, prizes, bands, top,
    // independent entries can all land on one card; exclusive pays at most one
    maxCardUsd: (top?.usd ?? 0) * (card.roll === 'independent' ? card.pays.length : 1),
    missingPrices: [...missing],
  }
}

/** Cumulative RTP from the largest payout down — where the money actually sits. */
export function cumulative(rows: LadderRow[]) {
  let acc = 0
  return rows
    .filter(r => r.multiple > 0)
    .map(r => {
      acc += r.rtp
      return { multiple: r.multiple, cum: acc }
    })
}
