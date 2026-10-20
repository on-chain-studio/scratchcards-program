import { Card, PrizeRow, TOTAL, LINEAR, TARGET_RTP, PRIZE_ROWS, decimalsOf, normalize, offered, rowUsd } from './types'
import { Prices } from './analytics'

/**
 * The nearest round number a prize would sensibly be printed as: a payout of 4713 BONK reads
 * like a rounding error, 5000 reads like a prize.
 */
export function nice(units: number, token: string): number {
  if (units <= 0) return 0
  const scale = 10 ** decimalsOf(token)
  const x = units / scale
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]
  const base = 10 ** Math.floor(Math.log10(x))
  let best: number | null = null
  for (const s of steps) {
    const v = Math.round(s * base * scale)
    if (v < 1) continue
    if (best === null || Math.abs(v - units) < Math.abs(best - units)) best = v
  }
  return best ?? 1
}

/** The nearest round number at or above `units` — for a prize that must not fall below a floor. */
export function niceUp(units: number, token: string): number {
  if (units <= 0) return 0
  const scale = 10 ** decimalsOf(token)
  const x = units / scale
  const base = 10 ** Math.floor(Math.log10(x))
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    const v = Math.round(s * base * scale)
    if (v >= units && v >= 1) return v
  }
  return Math.max(1, Math.round(10 * base * scale))
}

/** Whether a prize is already printed on the round steps `nice` snaps to. */
export const isNice = (units: number, token: string) => units === nice(units, token)

/** A prize in `token` worth about what row `r`'s other coins pay, in round units. */
export function matchingAmount(card: Card, prices: Prices, token: string, r: number): number {
  const usd = rowUsd(card.tokens, card.prizes[r]?.amounts ?? [], prices)
  const price = prices[token] ?? 0
  if (usd <= 0 || price <= 0) return 1
  return nice((usd / price) * 10 ** decimalsOf(token), token)
}

/**
 * USD one card returns in prizes, as an expectation.
 *
 * The payout is exactly linear in each draw — the outcome, the multiplier, the tier and the coin
 * are independent — so the expectation needs no sampling.
 */
export function returnUsd(card: Card, prices: Prices): number {
  const tierSum = card.tiers.reduce((n, t) => n + t.weight, 0)
  const multiplier = 1 - tierSum / TOTAL + card.tiers.reduce((n, t) => n + (t.weight / TOTAL) * t.factor, 0)
  const prize = card.prizes.reduce((n, row) => n + (row.weight / TOTAL) * rowUsd(card.tokens, row.amounts, prices), 0)
  const outcomes = card.pays.reduce((n, p) => n + (p.weight / TOTAL) * p.mult * ((p.flags & LINEAR) ? p.min : 1), 0)
  return outcomes * multiplier * prize
}

export interface SolvedOdds {
  weights: number[]
  rtp: number
  before: number
  /** hit the ceiling before reaching target — exclusive weights cannot exceed 2³² together */
  clamped: boolean
}

/**
 * Balances on the card's own odds: scales every pay weight by one factor, leaving prizes and
 * tiers untouched. A player sees this as the card paying more or less often, never as the
 * printed prize changing.
 */
export function solveOdds(card: Card, prices: Prices, target = TARGET_RTP): SolvedOdds {
  const priceUsd = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const current = returnUsd(card, prices)
  const before = priceUsd > 0 ? current / priceUsd : 0
  const weights = card.pays.map(p => p.weight)
  if (current <= 0 || priceUsd <= 0 || before <= 0) {
    return { weights, rtp: before, before, clamped: false }
  }

  let k = target / before
  let clamped = false
  const sum = weights.reduce((n, w) => n + w, 0)
  if (card.roll === 'exclusive' && sum * k > TOTAL) {
    k = TOTAL / sum
    clamped = true
  } else if (card.roll === 'independent') {
    const worst = Math.max(...weights)
    if (worst * k > TOTAL) { k = TOTAL / worst; clamped = true }
  }

  const scaled = weights.map(w => Math.round(w * k))
  return { weights: scaled, rtp: before * k, before, clamped }
}

export interface Ladder {
  /** per tier, per coin, base units; 0 = the tier does not offer that coin */
  amounts: number[][]
  /** tier weights */
  weights: number[]
  payWeights: number[]
  rtp: number
  /** what the top prize actually landed on, once the pin and the odds solve settled */
  topOdds: number
  /** the pay table alone already spans more than the requested range */
  overrun: number
  span: number
}

const TOP = PRIZE_ROWS - 1

/** The coins each tier offers, as the card says now; a tier offering none is left empty. */
const offering = (card: Card) =>
  Array.from({ length: PRIZE_ROWS }, (_, r) => card.prizes[r] ? offered(card.prizes[r]) : [])

/**
 * The value each tier is designed to pay, from the two ends of the curve.
 *
 * A multiple is `tier value x pay mult x multiplier / ticket`, so min pins the low tier and max
 * the top one outright; mid and high interpolate geometrically between them.
 */
function tierValues(card: Card, prices: Prices, minX: number, maxX: number) {
  const priceUsd = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const lo = (minX * priceUsd) / Math.min(...mults)
  const paySpan = (Math.max(...mults) * topTier) / Math.min(...mults)
  const span = maxX / Math.max(minX, 1e-9)
  // Never let the ladder run backwards. Once the pay table spans more than the range asked for
  // there is nothing left for the tiers to add, so they all take the same value — the top prize
  // is then min x paySpan whatever `max` says, which is what the caller is told.
  const hi = Math.max((maxX * priceUsd) / (Math.max(...mults) * topTier), lo)
  const ratio = hi / lo
  const values = Array.from({ length: PRIZE_ROWS }, (_, r) => lo * Math.pow(ratio, r / TOP))
  return { priceUsd, lo, values, overrun: paySpan / span, span }
}

/** The headline: the dearest coin the top tier offers, at these amounts. */
function headline(card: Card, prices: Prices, top: number[]) {
  let best = -1, usd = -1
  top.forEach((a, t) => {
    if (a <= 0) return
    const v = (a / 10 ** decimalsOf(card.tokens[t])) * (prices[card.tokens[t]] ?? 0)
    if (v > usd) { usd = v; best = t }
  })
  return best
}

/**
 * Builds every prize from the two ends of the curve.
 *
 * Each tier's value comes off the curve (see tierValues) and every coin the tier offers prints
 * that value in its own units, rounded to a round number — so a tier's coins are worth about the
 * same, and a win's coin is decoration on the tier's value. `bend` then decides how the weight
 * sits on the tiers — weight proportional to value^-bend, so 0 is uniform, 1 gives every tier an
 * equal share of the return, and above 1 piles the mass onto the low tier, which is what makes
 * most wins small.
 *
 * That fixes prizes and tier weights, which leaves RTP to the pay table: every pay weight is
 * scaled by one factor at the end. The player sees the card pay more or less often; no printed
 * prize moves.
 */
export function solveLadder(
  card: Card, prices: Prices, minX: number, maxX: number, bend: number,
  target = TARGET_RTP, topOneIn = 0,
): Ladder {
  const empty: Ladder = {
    amounts: card.prizes.map(r => r.amounts), weights: card.prizes.map(r => r.weight),
    payWeights: card.pays.map(p => p.weight), rtp: 0, overrun: 1, span: 1, topOdds: Infinity,
  }
  const { priceUsd, values, overrun, span } = tierValues(card, prices, minX, maxX)
  if (priceUsd <= 0 || !card.tokens.length || !card.pays.length) return empty

  const offers = offering(card)
  const ideal = (r: number, t: number) => {
    const price = prices[card.tokens[t]] ?? 0
    return price > 0 ? (values[r] / price) * 10 ** decimalsOf(card.tokens[t]) : card.prizes[r].amounts[t]
  }
  // The low tier is the bottom of the ladder, so it may only round up: snapping it down would put
  // outcomes below the `min` the whole card was designed around, and with weight piled on the
  // cheap end that one rounding takes a large share of the return under the ticket price.
  // Rounding up overshoots RTP a little; the odds solve takes that back out of the win rate,
  // which is the whole point of separating the two — prizes are the design, frequency is the
  // balance. The other tiers round to the NEAREST step: an ideal just past a step must not
  // overshoot a third, which thins that tier's odds and hands the odds solve return to claw back.
  const amounts = offers.map((ts, r) => card.tokens.map((tok, t) => {
    if (!ts.includes(t)) return 0
    return r === 0 ? niceUp(ideal(r, t), tok) : Math.max(1, nice(ideal(r, t), tok))
  }))
  // The headline must stay the dearest print on the card: a high-tier coin with coarse steps can
  // round up past it, and then the card's face is the wrong prize. Step it up until it out-values
  // everything below.
  const below = Math.max(0, ...amounts.slice(0, TOP).flatMap(row => row.map((a, t) =>
    (a / 10 ** decimalsOf(card.tokens[t])) * (prices[card.tokens[t]] ?? 0))))
  amounts[TOP] = amounts[TOP].map((a, t) => {
    const tok = card.tokens[t], price = prices[tok] ?? 0
    if (a <= 0 || price <= 0) return a
    const scale = 10 ** decimalsOf(tok)
    return (a / scale) * price <= below ? niceUp(((below * 1.02) / price) * scale, tok) : a
  })

  const out = weighAmounts(card, prices, amounts, values, bend, target, topOneIn)
  return { amounts, ...out, overrun, span }
}

/**
 * The balance half of every solve: tier weights from the bend, pay weights landing RTP, and
 * the optional top-prize pin. Takes the amounts as given — where they came from (the ladder,
 * the printed sheet, or a compromise between the two) is the caller's philosophy, not this
 * function's.
 */
function weighAmounts(
  card: Card, prices: Prices, amounts: number[][], ideals: number[], bend: number,
  target: number, topOneIn: number,
): { weights: number[]; payWeights: number[]; rtp: number; topOdds: number } {
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))

  // Bend is a statement about multiples, not about tiers: an outcome paying m should be
  // weighted m^-bend wherever that m comes from. Applying it only to the tiers made it inert on
  // a card whose spread is in the pay table — every tier there holds the same value, so
  // value^-bend is uniform for any bend. At bend 1 each rung returns the same share of RTP,
  // which is the halve-the-chance-as-the-prize-doubles ladder written as one number.
  const bendOf = (x: number) => Math.pow(Math.max(x, 1e-12), -bend)

  /**
   * Split each multiple's weight across the routes that reach it.
   *
   * The Vault has two lines paying ×1, four paying ×2 and two paying ×5. A player sees the
   * amount, not which line produced it, so without this the ×2 prizes arrive twice as often as
   * the curve says and end up more common than dearer ×1 prizes in a better tier.
   */
  const routes = new Map<number, number>()
  for (const m of mults) routes.set(m, (routes.get(m) ?? 0) + 1)

  /**
   * Weight against what a tier actually pays, not what the ladder asked for: rounding moves a
   * value by up to a fifth, and weighting the ideal would leave weight and payout disagreeing.
   * A tier that offers no coin can't be drawn.
   */
  const live = amounts.map(row => row.some(a => a > 0))
  const realised = amounts.map((row, r) => rowUsd(card.tokens, row, prices) || ideals[r])
  const top = headline(card, prices, amounts[TOP])
  const topShare = 1 / Math.max(1, amounts[TOP].filter(a => a > 0).length)
  // every pay entry reaching the top multiple is another route to the same prize, and a player
  // only sees the amount — so the pin counts them all rather than one
  const topMult = Math.max(...mults)
  const topRoutes = mults.map((m, i) => (m === topMult ? i : -1)).filter(i => i >= 0)

  const shapedAt = (bp: number) =>
    normalize(mults.map(m => Math.pow(Math.max(m, 1e-12), -bp) / (routes.get(m) ?? 1)))
  const flat = realised[TOP] <= realised[0] * 1.3
  const n = live.filter(Boolean).length

  const assemble = (share: number | null, bp = bend) => {
    let weights: number[]
    if (share === null || share === undefined || !live[TOP]) {
      weights = normalize(realised.map((v, r) => (live[r] ? bendOf(v) : 0)))
    } else {
      // A share above 1/n cannot be monotone -- the top would beat a cheaper tier by pigeonhole.
      const pinned = Math.max(1, Math.min(Math.floor(TOTAL / n), Math.round(share * TOTAL)))
      const lower = realised.map((v, r) => (r !== TOP && live[r] ? bendOf(v) : 0))
      let rest = normalize(lower, TOTAL - pinned)
      /**
       * No cheaper tier may be rarer than the pinned top. The curve decays past the pin's level
       * near its high end, which reads as "the best prize has the best odds" on the sheet -- so
       * tiers that fall under the pin are floored at it, and the curve keeps only what remains.
       * Waterfill: flooring one shrinks the rest, which may push another under the floor, so
       * repeat until the floored set is stable.
       */
      for (let pass = 0; pass < PRIZE_ROWS; pass++) {
        const low = rest.map((w, r) => (live[r] && r !== TOP && w < pinned ? r : -1)).filter(r => r >= 0)
        if (!low.length) break
        const free = rest.map((_, r) => r).filter(r => live[r] && r !== TOP && !low.includes(r))
        const next = rest.slice()
        low.forEach(r => { next[r] = pinned })
        if (!free.length) { rest = next; break }
        const redone = normalize(free.map(r => rest[r]), Math.max(free.length, TOTAL - pinned - low.length * pinned))
        free.forEach((r, j) => { next[r] = redone[j] })
        rest = next
      }
      weights = rest.map((w, r) => (r === TOP ? pinned : w))
    }
    const staged: Card = {
      ...card,
      prizes: amounts.map((a, r): PrizeRow => ({ weight: weights[r], amounts: a })),
      pays: card.pays.map((p, i) => ({ ...p, weight: shapedAt(bp)[i] })),
    }
    const solved = solveOdds(staged, prices, target)
    /**
     * What event the pin aims at depends on the tiers' shape. Spread tiers make the headline
     * "top mult on the top tier's dearest coin". Flat tiers (every tier worth about the same)
     * make any tier at the top mult pay the headline, so the big-win event is the mult chance
     * alone, and the tier share would overshoot it.
     */
    const achieved = topRoutes.reduce((n2, i) => n2 + solved.weights[i] / TOTAL, 0)
      * (flat ? 1 : (weights[TOP] / TOTAL) * topShare)
    return { weights, payWeights: solved.weights, rtp: solved.rtp, achieved }
  }

  let out = assemble(null)
  if (topOneIn && topOneIn > 0 && top >= 0) {
    /**
     * The pin has one dial, picked by the card's shape.
     *
     * A card with a mult chain corrects through the chain's own exponent: the pays keep a
     * power law, just a gentler one than the tiers', so the chain stays strictly decreasing
     * and the correction spreads over every rung instead of piling onto one. achieved falls
     * monotonically as the exponent rises, so a bisection lands it deterministically.
     *
     * A flat-mult card has no chain to tilt -- there the top tier's share is the dial, walked
     * to the target with the waterfill keeping the tiers monotone.
     *
     * Either dial only makes the top more common than its curve position. Rarer is not a
     * pin's job -- that is what max and bend are for.
     */
    const want = 1 / topOneIn
    const spanM = Math.max(...mults) / Math.min(...mults)
    if (spanM > 1) {
      const natural = assemble(null, bend)
      if (natural.achieved < want) {
        let lo = 0, hi = bend
        for (let i = 0; i < 40; i++) {
          const bp = (lo + hi) / 2
          const r = assemble(null, bp)
          // lower exponent -> flatter chain -> commoner top
          if (r.achieved > want) lo = bp; else hi = bp
        }
        out = assemble(null, (lo + hi) / 2)
      } else {
        out = natural
      }
    } else {
      let share = out.weights[TOP] / TOTAL
      let best = assemble(share)
      for (let i = 0; i < 40; i++) {
        if (Math.abs(best.achieved - want) <= want * 1e-3) break
        const f = want / Math.max(best.achieved, 1e-18)
        share = Math.max(1e-12, Math.min(0.2, share * f))
        best = assemble(share)
      }
      out = best
    }
  }

  return {
    weights: out.weights, payWeights: out.payWeights,
    rtp: out.rtp, topOdds: out.achieved > 0 ? 1 / out.achieved : Infinity,
  }
}

/**
 * The bend that lands a win rate. Bend is not a taste knob: steeper piles the return onto
 * cheap outcomes, which at a fixed RTP means more of them — so the win-one-in aim picks the
 * bend, at today's prices, and a rebalance re-derives it rather than reusing yesterday's.
 */
export function solveBend(
  card: Card, prices: Prices, minX: number, maxX: number, winOneIn: number,
  target = TARGET_RTP, topOneIn = 0,
): number {
  let lo = 0.5
  let hi = 6
  for (let i = 0; i < 40; i++) {
    const bend = (lo + hi) / 2
    const L = solveLadder(card, prices, minX, maxX, bend, target, topOneIn)
    const tierSum = L.weights.reduce((a, w) => a + w, 0)
    const win = L.payWeights.reduce((a, w) => a + w, 0) / TOTAL * (tierSum / TOTAL)
    if (1 / win > winOneIn) lo = bend; else hi = bend
  }
  return (lo + hi) / 2
}

/** No card's headline may be rarer than this — scarcer stops being a prize and starts being a lie. */
// A whisker under the stated 1:300k limit: the solver's internal odds measure and the
// player-facing merged ladder differ by a few percent, and the limit binds the latter.
export const TOP_ONE_IN_CAP = 280_000

/** The slice of every ticket the top prize costs — equal on every card, so prize scales with spend. */
export const TOP_EV_SHARE = 0.001

/**
 * The whole per-card solve: bend from the win aim, and — on a card whose top rides the
 * natural curve — max walked down until the headline's odds respect the cap. On a mixed
 * card the top's rarity is bought with max and nothing else honors a ceiling, so the
 * ceiling owns max; a pinned card holds its odds by the pin and keeps the max it asked for.
 */
export function solveShelf(
  card: Card, prices: Prices,
  d: { min: number; max: number; winOneIn: number; top: number },
  target = TARGET_RTP, share = TOP_EV_SHARE,
): { max: number; bend: number; ladder: Ladder } {
  const solveAt = (mx: number) => {
    const bend = solveBend(card, prices, d.min, mx, d.winOneIn, target, 0)
    return { bend, L: solveLadder(card, prices, d.min, mx, bend, target, 0) }
  }
  /**
   * The cap binds the PRINTED top prize — the odds a player reads beside the headline —
   * not the ladder's internal pin event, which on near-flat tiers is "the top multiple on
   * any token" and can be ten times commoner than the headline row itself.
   */
  const capMults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const capTop = Math.max(...capMults)
  const headlineOneIn = (L: Ladder) => {
    const tierSum = L.weights.reduce((a, w) => a + w, 0) || 1
    const pRoute = capMults.reduce((a, m, i) => a + (m === capTop ? L.payWeights[i] : 0), 0) / TOTAL
    const coins = Math.max(1, L.amounts[TOP].filter(a => a > 0).length)
    const p = pRoute * (L.weights[TOP] / tierSum) / coins
    return p > 0 ? 1 / p : Infinity
  }
  const priceUsd2 = (card.priceLamports / 1e9) * (prices.SOL ?? 0)
  const head = (L: Ladder) => Math.max(0, headline(card, prices, L.amounts[TOP]))
  const tok2Of = (L: Ladder) => card.tokens[head(L)]
  /**
   * The headline's odds are not a free knob: every ticket spends the same slice of itself
   * on the top prize, on every card. Odds derive from the printed prize — one-in equals the
   * headline multiple over the share — so doubling the prize always costs exactly double
   * the spend, never fourteen times. The cap still bounds the rarest allowed.
   */
  const printedTarget = (L: Ladder) => {
    const tok2 = tok2Of(L)
    const topVal = (L.amounts[TOP][head(L)] / 10 ** decimalsOf(tok2)) * (prices[tok2] ?? 0) * capTop
    return Math.min(TOP_ONE_IN_CAP, Math.round(topVal / priceUsd2 / share))
  }
  let max = d.max
  let r = solveAt(max)
  {
    // How hard the pin may pull without distorting: a flat-mult card's share dial is always
    // clean, and near-flat tiers have no cross-dimension value ties for a tilt to invert —
    // both take any pull. A genuinely mixed card caps at ~3x; beyond that, the headline
    // steps down the printed ladder until its target is within reach.
    const vals = r.L.amounts.map(row => rowUsd(card.tokens, row, prices)).filter(v => v > 0)
    const tierSpan = Math.max(...vals) / Math.max(1e-9, Math.min(...vals))
    const cleanPull = capTop <= 1 || tierSpan < 1.5 ? Infinity : 3
    const mults = capMults
    const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
    const paysTop = Math.max(...mults) * topTier
    for (let i = 0; i < 14 && headlineOneIn(r.L) > printedTarget(r.L) * cleanPull; i++) {
      const tok2 = tok2Of(r.L)
      const cur = r.L.amounts[TOP][head(r.L)]
      const down = Math.max(1, nice(cur * 0.79, tok2))
      if (down >= cur) break
      const next = ((down / 10 ** decimalsOf(tok2)) * (prices[tok2] ?? 0) * paysTop) / priceUsd2
      if (!(next > d.min * 1.1)) break
      max = next
      r = solveAt(max)
    }
    // Land the derived odds through the pin, aimed by measurement. A flat-mult card's
    // share dial moves both ways, so it also engages when the natural top is too COMMON
    // for the share; a tilt card can only pull commoner, so rarer-than-natural is accepted.
    const off = () => headlineOneIn(r.L) / printedTarget(r.L)
    const engage = () => off() > 1.02 || (capTop <= 1 && off() < 1 / 1.02)
    if (engage()) {
      let t = printedTarget(r.L)
      for (let i = 0; i < 8 && engage(); i++) {
        r = { bend: r.bend, L: solveLadder(card, prices, d.min, max, r.bend, target, t) }
        t = Math.max(1000, Math.round(t / off()))
      }
      // The pin's tail EV comes out of the win rate and stays out: re-solving bend with the
      // pin active couples two searches that chase each other (tried three times, diverged
      // three times). The win-rate cost is the honest price of a proportional top.
    }
  }
  return { max, bend: r.bend, ladder: r.L }
}

/**
 * Rebalances a card treating its commitments as aims rather than rules.
 *
 * Three things compete when prices move: the printed amounts (a player recognises their card),
 * the design ladder (the USD shape the card was tuned to), and RTP (the house edge). The first
 * two are scored against each other per rung — a prize moves only when its value has drifted
 * far enough off the ladder that the reprint beats the churn — and RTP is then landed exactly
 * by the pay-table solve, which touches neither of the other two.
 *
 * `sticky` prices the reprint: 0 rebuilds every amount from the ladder (solveLadder's answer),
 * 1 holds a prize until its value drifts roughly a third off its rung, higher holds longer.
 */
export function solveBalanced(
  card: Card, prices: Prices, minX: number, maxX: number, bend: number,
  target = TARGET_RTP, topOneIn = 0, sticky = 1,
): Ladder {
  const empty: Ladder = {
    amounts: card.prizes.map(r => r.amounts), weights: card.prizes.map(r => r.weight),
    payWeights: card.pays.map(p => p.weight), rtp: 0, overrun: 1, span: 1, topOdds: Infinity,
  }
  const { priceUsd, lo, values, overrun, span } = tierValues(card, prices, minX, maxX)
  if (priceUsd <= 0 || !card.tokens.length || !card.pays.length) return empty

  const amounts = card.prizes.map((row, r) => row.amounts.map((held, t) => {
    const tok = card.tokens[t], price = prices[tok] ?? 0
    if (held < 1 || price <= 0) return held
    const scale = 10 ** decimalsOf(tok)
    const usdOf = (a: number) => (a / scale) * price
    // candidates: hold, the tier's ideal, and the round steps between them
    const options = new Set<number>([held, niceUp((values[r] / price) * scale, tok)])
    for (const f of [0.5, 0.667, 0.8, 1.25, 1.5, 2]) options.add(nice(held * f, tok))
    // nothing may land under the bottom of the ladder (see solveLadder) — unless even the
    // tier's own ideal sits there, which happens when the pay table spans the whole range
    const floor = Math.min(lo, values[r]) * 0.999
    const legal = [...options].filter(a => a >= 1 && usdOf(a) >= floor)
    if (!legal.length) return niceUp((values[r] / price) * scale, tok)
    // shape error against the ladder, plus what the move itself costs — holding is free
    const cost = (a: number) =>
      Math.abs(Math.log(usdOf(a) / values[r])) +
      (a === held ? 0 : sticky * (0.15 + 0.5 * Math.abs(Math.log(a / held))))
    return legal.reduce((best, a) => (cost(a) < cost(best) ? a : best))
  }))

  const out = weighAmounts(card, prices, amounts, values, bend, target, topOneIn)
  return { amounts, ...out, overrun, span }
}

/**
 * How the requested range divides between the card and its prize tiers.
 *
 * A top multiple is `min x card spread x tier spread`. The card's is fixed by its own design —
 * Match Three's rungs run x1 to x100 before a tier is drawn. Whatever the range leaves over is
 * the spread the prize tiers can have, and on a card like that there is little left: the tiers
 * then sit close together and the spread genuinely lives in the pay table.
 */
export function ladderSplit(card: Card, minX: number, maxX: number) {
  if (!card.pays.length) return { rungs: 1, tiers: 1, pay: 1, prizes: 1, top: minX }
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const rungs = Math.max(...mults) / Math.min(...mults)
  const tiers = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const pay = rungs * tiers
  const prizes = Math.max(1, maxX / Math.max(minX, 1e-9) / pay)
  return { rungs, tiers, pay, prizes, top: minX * pay * prizes }
}

export interface Targets {
  bend: number
  max: number
  winOneIn: number
  turnover: number
}

/**
 * Finds the `bend` and `max` that hit a win rate and a headline turnover together, staying on
 * the curve.
 *
 * The alternative — pinning the top prize off the curve — buys the frequency but makes the top
 * tier common, so it overtakes cheaper tiers and the published table reads as broken. Here nothing leaves the curve, so the table stays
 * monotone; the price is a lower ceiling, since bringing the headline within reach on the curve
 * means shortening the ladder.
 *
 * The two knobs are nearly independent — bend moves the win rate, max moves the headline — so
 * bisecting each in turn converges in a handful of passes.
 */
export function solveTargets(
  card: Card, prices: Prices, minX: number,
  winOneIn = 3, turnover = 1000, target = TARGET_RTP,
): Targets {
  const priceSol = card.priceLamports / 1e9
  const measure = (bend: number, max: number) => {
    const L = solveLadder(card, prices, minX, max, bend, target, 0)
    const p = L.payWeights.map(w => w / TOTAL)
    const winRate = card.roll === 'independent'
      ? 1 - p.reduce((n, x) => n * (1 - x), 1)
      : p.reduce((n, x) => n + x, 0)
    return { winRate, turnover: priceSol * L.topOdds }
  }

  // The tiers only add spread beyond what the pay table already provides. Below
  // minX × paySpan the overrun clamp flattens the tiers, so every ceiling down there is the
  // same card — turnover stops responding, and a bisection that wanders in converges on the
  // meaningless floor (a Match Three "solve" collapsed max to 1.1× exactly this way). The
  // pay table's own span is the honest lower bound for the ceiling.
  const mults = card.pays.map(p => p.mult * ((p.flags & LINEAR) ? p.min : 1))
  const topTier = Math.max(1, ...card.tiers.filter(t => t.weight > 0).map(t => t.factor))
  const paySpan = mults.length ? (Math.max(...mults) * topTier) / Math.min(...mults) : 1
  const ceilingFloor = minX * Math.max(paySpan, 1.05)

  let bend = 2
  let max = Math.max(ceilingFloor, minX * 2, 50)

  for (let pass = 0; pass < 8; pass++) {
    // higher bend piles weight on the cheap end, so the card pays more often
    let lo = 0.05, hi = 8
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (measure(mid, max).winRate < 1 / winOneIn) lo = mid; else hi = mid
    }
    bend = (lo + hi) / 2

    // a higher ceiling makes the dearest prize rarer, so more sales per hit
    let l2 = ceilingFloor, h2 = 20_000
    for (let i = 0; i < 40; i++) {
      const mid = (l2 + h2) / 2
      if (measure(bend, mid).turnover < turnover) l2 = mid; else h2 = mid
    }
    max = (l2 + h2) / 2
  }

  const got = measure(bend, max)
  return { bend, max, winOneIn: 1 / got.winRate, turnover: got.turnover }
}
