import { useEffect, useState } from 'react'

/**
 * The treasury per token: what the house can still pay at settle, what the vault can still
 * pay at withdraw, and how many worst-case wins the house balance covers. The keeper restocks
 * at 1.5× worst — below that is LOW, below 1× a single top prize cannot be paid.
 */

type TokenBal = { house: number; pool: number; worst: number; price: number }
type Balances = {
  ok: boolean; error?: string; where?: string
  sol: TokenBal; tokens: Record<string, TokenBal>
}
type Cluster = 'mainnet' | 'devnet'

const fmtVal = (n: number) =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 3 : 1 })

export function TreasuryView() {
  const [cluster, setCluster] = useState<Cluster>('mainnet')
  const [bal, setBal] = useState<Balances | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setBal(null)
    fetch(`/__sheet/balances?cluster=${cluster}${nonce ? '&fresh=1' : ''}`)
      .then(r => r.json()).then(setBal)
      .catch(e => setBal({ ok: false, error: String(e) } as Balances))
  }, [cluster, nonce])

  if (bal && !bal.ok) return <div className="banner"><strong>Treasury unavailable</strong><span>{bal.error}</span></div>
  const rows = bal ? [
    ['SOL', bal.sol] as const,
    ...Object.entries(bal.tokens).sort(([a], [b]) => a.localeCompare(b)),
  ] : []
  const badge = (r: TokenBal) => {
    if (!r.worst) return null
    const x = r.house / r.worst
    const [label, color] = x < 1 ? ['SHORT', 'var(--danger, #d33)']
      : x < 1.5 ? ['LOW', 'var(--warn, #c80)'] : ['OK', 'var(--ok, #2a7)']
    return <span style={{ color, fontWeight: 600 }}>{label} {x.toFixed(1)}×</span>
  }

  return (
    <div className="card">
      <h2>
        Treasury {bal?.where ? `— ${bal.where}` : ''}
        {' '}<button className="mini" onClick={() => setNonce(n => n + 1)}>refresh</button>
      </h2>
      <div className="poolsolve" style={{ gap: 8 }}>
        <span style={{ display: 'inline-flex', gap: 4 }}>
          {(['mainnet', 'devnet'] as Cluster[]).map(c => (
            <button key={c} className="tab" aria-selected={cluster === c} onClick={() => setCluster(c)}>{c}</button>
          ))}
        </span>
      </div>
      <div className="scroll">
        <table>
          <thead><tr>
            <th>token</th><th>house (pays wins)</th><th>pool (pays withdrawals)</th>
            <th>worst collect</th><th>coverage</th>
          </tr></thead>
          <tbody>
            {rows.map(([sym, r]) => (
              <tr key={sym}>
                <td>{sym}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {fmtVal(r.house)}{r.price ? ` ($${(r.house * r.price).toFixed(2)})` : ''}
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtVal(r.pool)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.worst ? fmtVal(r.worst) : '—'}</td>
                <td>{badge(r) ?? '—'}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="note">loading treasury…</td></tr>}
            {rows.length > 0 && (() => {
              const usd = (f: (r: TokenBal, sym: string) => number) =>
                rows.reduce((n, [sym, r]) => n + f(r, sym) * r.price, 0)
              const cell = (v: number) => (
                <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>${v.toFixed(2)}</td>
              )
              return (
                <tr style={{ borderTop: '2px solid var(--border, #888)' }}>
                  <td style={{ fontWeight: 600 }}>Total</td>
                  {cell(usd(r => r.house))}
                  {cell(usd(r => r.pool))}
                  <td /><td />
                </tr>
              )
            })()}
          </tbody>
        </table>
      </div>
    </div>
  )
}
