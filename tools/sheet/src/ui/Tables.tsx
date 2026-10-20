import { useState } from 'react'
import { Card, MAX_TOKENS, ROW_NAMES, TOTAL, whole } from '../model/types'
import { Summary, Prices } from '../model/analytics'
import { isNice, nice } from '../model/solve'
import { fmt, usd, pct, oneIn } from './format'
import { AmountInput } from './Weight'

/**
 * The prize tiers: one column per tier, one row per coin. A cell is what that coin prints when a
 * win lands in that tier; an empty cell is a coin the tier doesn't offer. Inside a tier the coin
 * is drawn uniformly, so a tier's coins should all be worth about its value.
 */
export function PrizeTable({
  card, summary, prices, onAmount, onOffer, onAddToken, onRemoveToken,
}: {
  card: Card
  summary: Summary
  prices: Prices
  onAmount: (row: number, token: number, amount: number) => void
  onOffer: (row: number, token: number, on: boolean) => void
  onAddToken: (token: string) => void
  onRemoveToken: (token: number) => void
}) {
  const spare = Object.keys(prices).filter(t => !card.tokens.includes(t)).sort()
  const perTier = new Map<number, number>()
  const perCoin = new Map<number, number>()
  for (const row of summary.rows) {
    perTier.set(row.rowIndex, (perTier.get(row.rowIndex) ?? 0) + row.rtp)
    perCoin.set(row.tokenIndex, (perCoin.get(row.tokenIndex) ?? 0) + row.rtp)
  }
  const times = (token: string, units: number) => {
    const price = prices[token]
    return price === undefined || summary.priceUsd <= 0 ? '—' : `${fmt((whole(token, units) * price) / summary.priceUsd, 2)}×`
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Coin</th>
            <th>Price</th>
            {ROW_NAMES.map((name, r) => (
              <th key={name} title="the tier's draw chance, given a win">
                {name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{pct((card.prizes[r]?.weight ?? 0) / TOTAL, 1)}</span>
              </th>
            ))}
            <th>RTP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {card.tokens.map((token, t) => (
            <tr key={token}>
              <td>{token}</td>
              <td style={{ color: 'var(--muted)' }}>{prices[token] === undefined ? '—' : usd(prices[token])}</td>
              {card.prizes.map((row, r) => {
                const units = row.amounts[t] ?? 0
                if (units <= 0) {
                  return (
                    <td key={r}>
                      <button className="mini" title={`offer ${token} in the ${ROW_NAMES[r]} tier`}
                        onClick={() => onOffer(r, t, true)}>+</button>
                    </td>
                  )
                }
                return (
                  <td key={r} style={{ whiteSpace: 'nowrap' }}>
                    <AmountInput token={token} units={units} onChange={u => onAmount(r, t, u)} />
                    <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>{times(token, units)}</span>
                    {!isNice(units, token) && (
                      <button
                        className="chip warn"
                        title={`Nearest printable prize is ${fmt(whole(token, nice(units, token)), 4)}`}
                        onClick={() => onAmount(r, t, nice(units, token))}
                      >
                        not round
                      </button>
                    )}
                    <button className="mini" title={`stop offering ${token} in the ${ROW_NAMES[r]} tier`}
                      onClick={() => onOffer(r, t, false)}>−</button>
                  </td>
                )
              })}
              <td>{pct(perCoin.get(t) ?? 0, 2)}</td>
              <td>
                <button className="mini" title="remove coin"
                  disabled={card.tokens.length <= 1}
                  onClick={() => onRemoveToken(t)}>×</button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={2} style={{ color: 'var(--muted)' }}>tier RTP</td>
            {card.prizes.map((_, r) => <td key={r}>{pct(perTier.get(r) ?? 0, 2)}</td>)}
            <td colSpan={2} />
          </tr>
        </tbody>
      </table>

      {card.tokens.length < MAX_TOKENS && spare.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <select defaultValue="" onChange={e => { if (e.target.value) onAddToken(e.target.value) }}>
            <option value="">+ coin…</option>
            {spare.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            offered in low, mid and high at each tier's value
          </span>
        </div>
      )}
      {card.tokens.length >= MAX_TOKENS && (
        <div className="note">Every coin slot is used — {MAX_TOKENS} is the on-chain cap.</div>
      )}
    </div>
  )
}

export function PrizeList({ summary }: { summary: Summary }) {
  const [all, setAll] = useState(false)
  const prizes = summary.prizes
  const TOP = 12
  const shown = all ? prizes : prizes.slice(0, TOP)
  const rest = prizes.slice(shown.length)
  const restP = rest.reduce((n, r) => n + r.p, 0)
  const restRtp = rest.reduce((n, r) => n + r.rtp, 0)

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Prize</th>
            <th>Worth</th>
            <th>× ticket</th>
            <th>Odds</th>
            <th>Share of return</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map(p => (
            <tr key={p.key}>
              <td><strong>{fmt(p.amount, 4)}</strong> {p.token}</td>
              <td>{usd(p.usd)}</td>
              <td>{fmt(p.multiple, 2)}×</td>
              <td style={{ color: 'var(--muted)' }}>{oneIn(p.p)}</td>
              <td>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span className="bar-track" style={{ width: 74 }}>
                    <span className="bar-fill" style={{
                      width: `${summary.tokenRtp > 0 ? (p.rtp / summary.tokenRtp) * 100 : 0}%`,
                    }} />
                  </span>
                  {pct(p.rtp, 2)}
                </span>
              </td>
              <td style={{ color: 'var(--muted)', fontSize: 10 }}>
                {p.ways > 1 ? `${p.ways} ways` : ''}
              </td>
            </tr>
          ))}
          {rest.length > 0 && (
            <tr>
              <td colSpan={5} style={{ textAlign: 'left' }}>
                <button className="tab" onClick={() => setAll(true)}>
                  + {rest.length} smaller prizes — {pct(restRtp, 2)} of the price, {oneIn(restP)}
                </button>
              </td>
            </tr>
          )}
          {all && (
            <tr>
              <td colSpan={5} style={{ textAlign: 'left' }}>
                <button className="tab" onClick={() => setAll(false)}>show top {TOP} only</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
