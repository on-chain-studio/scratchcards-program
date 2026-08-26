import { useState } from 'react'
import { Card, MAX_POOL, whole } from '../model/types'
import { Summary, Prices } from '../model/analytics'
import { isNice, nice } from '../model/solve'
import { fmt, usd, pct, oneIn } from './format'
import { AmountInput } from './Weight'

export function PoolTable({
  card, summary, prices, onAmount, onAddToken, onRemoveToken, onReorder,
}: {
  card: Card
  summary: Summary
  prices: Prices
  onAmount: (index: number, amount: number) => void
  onAddToken: (token: string) => void
  onRemoveToken: (index: number) => void
  onReorder: (from: number, to: number) => void
}) {
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [grip, setGrip] = useState(false)
  const spare = Object.keys(prices)
    .filter(t => !card.pool.some(p => p.token === t))
    .sort()
  const perToken = new Map<number, number>()
  for (const row of summary.rows) {
    perToken.set(row.poolIndex, (perToken.get(row.poolIndex) ?? 0) + row.rtp)
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th />
            <th>Token</th>
            <th>Prize</th>
            <th>Price</th>
            <th>Worth</th>
            <th>× ticket</th>
            <th>RTP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {card.pool.map((entry, i) => {
            const price = prices[entry.token]
            const amount = whole(entry.token, entry.amount)
            return (
              <tr
                key={entry.token}
                draggable={grip}
                className={[
                  drag === i ? 'dragging' : '',
                  over === i && drag !== null && drag !== i ? (drag < i ? 'drop-below' : 'drop-above') : '',
                ].filter(Boolean).join(' ')}
                onDragStart={() => setDrag(i)}
                onDragOver={e => { e.preventDefault(); setOver(i) }}
                onDrop={e => {
                  e.preventDefault()
                  if (drag !== null && drag !== i) onReorder(drag, i)
                  setDrag(null); setOver(null); setGrip(false)
                }}
                onDragEnd={() => { setDrag(null); setOver(null); setGrip(false) }}
              >
                <td
                  className="grip"
                  title="drag to move along the ladder — higher is commoner"
                  onMouseDown={() => setGrip(true)}
                  onMouseUp={() => setGrip(false)}
                >
                  ⠿
                </td>
                <td>{entry.token}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <AmountInput token={entry.token} units={entry.amount} onChange={u => onAmount(i, u)} />
                  {!isNice(entry.amount, entry.token) && (
                    <button
                      className="chip warn"
                      title={`Nearest printable prize is ${fmt(whole(entry.token, nice(entry.amount, entry.token)), 4)}`}
                      onClick={() => onAmount(i, nice(entry.amount, entry.token))}
                    >
                      not round
                    </button>
                  )}
                </td>
                <td style={{ color: 'var(--muted)' }}>
                  {price === undefined ? '—' : usd(price)}
                </td>
                <td>{price === undefined ? '—' : usd(amount * price)}</td>
                <td style={{ fontWeight: 600 }}>
                  {price === undefined || summary.priceUsd <= 0
                    ? '—'
                    : `${fmt((amount * price) / summary.priceUsd, 2)}×`}
                </td>
                <td>{pct(perToken.get(i) ?? 0, 2)}</td>
                <td>
                  <button className="mini" title="remove token"
                    disabled={card.pool.length <= 1}
                    onClick={() => onRemoveToken(i)}>×</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {card.pool.length < MAX_POOL && spare.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <select defaultValue="" onChange={e => { if (e.target.value) onAddToken(e.target.value) }}>
            <option value="">+ token…</option>
            {spare.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            added at weight 0, so the sum stays exact until you give it one
          </span>
        </div>
      )}
      {card.pool.length >= MAX_POOL && (
        <div className="note">Pool is full — {MAX_POOL} is the on-chain cap.</div>
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
