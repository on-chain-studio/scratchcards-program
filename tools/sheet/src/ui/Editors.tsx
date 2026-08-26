import { Card, Block, Pay, Role, Roll, TOTAL, disjoint, MARKED, LINEAR, DISTINCT, MULT_OK, popcount, duelsOf } from '../model/types'
import { scopeName } from '../model/cards'
import { Summary } from '../model/analytics'
import { pct, oneIn } from './format'
import { WeightInput } from './Weight'

const ROLES: Role[] = ['plate', 'number', 'mark', 'jackpot']

export function BlockTable({
  card, onBlock, onAdd, onRemove,
}: {
  card: Card
  onBlock: (index: number, patch: Partial<Block>) => void
  onAdd: () => void
  onRemove: (index: number) => void
}) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Cells</th>
            <th>Cols</th>
            <th>Range</th>
            <th>Flags</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {card.blocks.map((b, i) => (
            <tr key={i}>
              <td>
                <select value={b.role}
                  onChange={e => onBlock(i, { role: e.target.value as Role })}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td>
                <input className="w-small" type="number" min={1} value={b.count}
                  onChange={e => onBlock(i, { count: Math.max(1, Number(e.target.value) || 1) })} />
              </td>
              <td>
                <input className="w-small" type="number" min={1} value={b.cols}
                  onChange={e => onBlock(i, { cols: Math.max(1, Number(e.target.value) || 1) })} />
              </td>
              <td>
                {b.role === 'number' || b.role === 'jackpot' ? (
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    <input className="w-small" type="number" value={b.a}
                      onChange={e => onBlock(i, { a: Number(e.target.value) || 0 })} />
                    <input className="w-small" type="number" value={b.b}
                      onChange={e => onBlock(i, { b: Number(e.target.value) || 0 })} />
                  </span>
                ) : <span style={{ color: 'var(--muted)' }}>—</span>}
              </td>
              <td style={{ textAlign: 'left' }}>
                <Flag on={!!(b.flags & DISTINCT)} label="distinct"
                  onToggle={() => onBlock(i, { flags: b.flags ^ DISTINCT })} />
                <Flag on={!!(b.flags & MULT_OK)} label="mult"
                  onToggle={() => onBlock(i, { flags: b.flags ^ MULT_OK })} />
              </td>
              <td>
                <button className="mini" onClick={() => onRemove(i)}
                  disabled={card.blocks.length <= 1} title="remove block">×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="tab" style={{ marginTop: 8 }} onClick={onAdd}>+ block</button>
    </div>
  )
}

function Flag({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button className={`chip toggle${on ? ' on' : ''}`} onClick={onToggle}>{label}</button>
  )
}

export function PayTable({
  card, summary, selected, onSelect, onHover, onPay, onAdd, onDuplicate, onRemove, onEven,
  onRoll,
}: {
  card: Card
  summary: Summary
  selected: number | null
  onSelect: (index: number | null) => void
  onHover: (scope: number | null) => void
  onPay: (index: number, patch: Partial<Pay>) => void
  onAdd: () => void
  onDuplicate: (index: number) => void
  onRemove: (index: number) => void
  onEven: () => void
  onRoll: (roll: Roll) => void
}) {
  const duels = duelsOf(card)
  const free = disjoint(card.pays.map(p => p.scope))
  const perPay = new Map<number, number>()
  for (const row of summary.rows) {
    perPay.set(row.payIndex, (perPay.get(row.payIndex) ?? 0) + row.rtp)
  }

  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Cells</th>
            <th>Min</th>
            <th>Mult</th>
            <th>Flags</th>
            <th>Chance</th>
            <th>Odds</th>
            <th>RTP</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {card.pays.map((pay, i) => {
            const p = pay.weight / TOTAL
            const bits = popcount(pay.scope)
            return (
              <tr key={i}
                className={selected === i ? 'selected' : ''}
                onClick={() => onSelect(selected === i ? null : i)}
                onMouseEnter={() => onHover(pay.scope)}
                onMouseLeave={() => onHover(null)}
              >
                <td>{scopeName(card, pay)}</td>
                <td style={{ color: 'var(--muted)' }}>
                  {bits} · 0x{pay.scope.toString(16).toUpperCase()}
                </td>
                <td onClick={e => e.stopPropagation()}>
                  <input
                    className={`w-small${pay.min > bits ? ' bad' : ''}`}
                    type="number" min={1} max={Math.max(bits, 1)} value={pay.min}
                    onChange={e => onPay(i, { min: Math.max(1, Number(e.target.value) || 1) })} />
                </td>
                <td onClick={e => e.stopPropagation()}>
                  <input className="w-small" type="number" min={1} value={pay.mult}
                    onChange={e => onPay(i, { mult: Math.max(1, Number(e.target.value) || 1) })} />
                </td>
                <td style={{ textAlign: 'left' }} onClick={e => e.stopPropagation()}>
                  <Flag on={!!(pay.flags & MARKED)} label="marked"
                    onToggle={() => onPay(i, { flags: pay.flags ^ MARKED })} />
                  {/* LINEAR (mult × min) is retired from authoring — grid still carries it
                      published, so show it read-only where it exists rather than hide it. */}
                  {!!(pay.flags & LINEAR) && <span className="chip">linear ·×{pay.min}</span>}
                </td>
                <td onClick={e => e.stopPropagation()}>
                  <WeightInput weight={pay.weight}
                    onChange={weight => onPay(i, { weight })} />
                </td>
                <td style={{ color: 'var(--muted)' }}>{oneIn(p)}</td>
                <td>{pct(perPay.get(i) ?? 0, 2)}</td>
                <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                  <button className="mini" title="duplicate" onClick={() => onDuplicate(i)}>⧉</button>
                  <button className="mini" title="remove" onClick={() => onRemove(i)}
                    disabled={card.pays.length <= 1}>×</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="tab" onClick={onAdd}>+ outcome</button>
        <button className="tab" onClick={onEven}>
          Split weight evenly ({card.pays.length} ways)
        </button>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
          {(['exclusive', 'independent'] as Roll[]).map(r => (
            <button key={r} className="tab" aria-selected={card.roll === r}
              disabled={r === 'independent' && !free}
              title={r === 'independent' && !free
                ? 'scopes overlap — independent rolls could not hold the declared odds'
                : undefined}
              onClick={() => onRoll(r)}>
              {r}
            </button>
          ))}
        </span>
      </div>

      <div className="note">
        {card.roll === 'exclusive' ? (
          <>
            <strong>Exclusive</strong> — one entry fires at most, so the weights partition 2³² and
            the shortfall is the miss rate. Right when entries are competing readings of the same
            board, or sit on cells that overlap.
          </>
        ) : (
          <>
            <strong>Independent</strong> — every entry rolls on its own and the payouts add up, so
            a card can pay several. Requires disjoint scopes: overlapping ones cannot roll
            independently and stay exact.
            {card.mode === 'compare' && ` Here that is ${duels} duels.`}{' '}
            RTP is unaffected either way — expectation adds whether or not the entries are
            independent, so only the spread above changes.
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The slot multiplier, as a table rather than the engine constants it used to be.
 *
 * Its span multiplies the whole pay ladder, so a ×10 here costs an order of magnitude of the
 * prize range — which is why it needs to be visible and editable rather than assumed.
 */
