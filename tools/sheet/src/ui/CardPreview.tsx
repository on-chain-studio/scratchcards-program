import { Card, Block, cellsOf, blockOffset } from '../model/types'

const ROLE_LABEL: Record<Block['role'], string> = {
  plate: 'Plates',
  number: 'Numbers',
  mark: 'Marks',
  jackpot: 'Jackpot line',
}

export function CardPreview({
  card, scope, editing, onToggleCell,
}: {
  card: Card
  scope: number | null
  /** true when a pay entry is selected, so body cells become clickable */
  editing: boolean
  onToggleCell: (cell: number) => void
}) {
  const lit = new Set(scope === null ? [] : cellsOf(scope))

  const cell = (index: number, block: Block) => {
    const clickable = editing && block.role !== 'jackpot'
    return (
      <div
        key={index}
        role={clickable ? 'button' : undefined}
        onClick={clickable ? () => onToggleCell(index) : undefined}
        className={[
          'cell',
          lit.has(index) ? 'lit' : '',
          block.role === 'jackpot' ? 'jackpot' : '',
          clickable ? 'clickable' : '',
        ].filter(Boolean).join(' ')}
      >
        {index}
      </div>
    )
  }

  /**
   * Compare already names the blocks that make a duel, so the preview reads the way the
   * card is actually printed — one row per duel — rather than one row per block.
   */
  const duels = () => {
    const [h, m, p] = card.modeArgs
    const blocks = [card.blocks[h], card.blocks[m], card.blocks[p]]
    if (blocks.some(b => !b) || new Set(blocks.map(b => b.count)).size !== 1) return null
    const starts = [h, m, p].map(i => blockOffset(card, i))

    return (
      <div className="blockrow">
        <div className="duelhead">
          <span>House</span><span>Yours</span><span>Prize</span>
        </div>
        {Array.from({ length: blocks[0].count }, (_, row) => (
          <div className="cells duel" key={row}>
            {blocks.map((b, col) => cell(starts[col] + row, b))}
          </div>
        ))}
      </div>
    )
  }

  const duelView = card.mode === 'compare' ? duels() : null
  const shown = duelView
    ? card.blocks.map((b, i) => ({ b, i })).filter(({ i }) => !card.modeArgs.slice(0, 3).includes(i))
    : card.blocks.map((b, i) => ({ b, i }))

  return (
    <div className="preview">
      {duelView}
      {shown.map(({ b, i }) => {
        const start = blockOffset(card, i)
        const cols = b.cols || b.count
        const label = b.role === 'number' ? `${ROLE_LABEL[b.role]} ${b.a}–${b.b}` : ROLE_LABEL[b.role]
        return (
          <div className="blockrow" key={i}>
            <div className="blocklabel">{label}</div>
            <div className="cells" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
              {Array.from({ length: b.count }, (_, k) => cell(start + k, b))}
            </div>
          </div>
        )
      })}
      <div className="note">
        {editing
          ? 'Click a body cell to add or remove it from the selected pay entry.'
          : 'Hover a pay entry to light its scope, or select one to edit it by clicking cells.'}
      </div>
    </div>
  )
}
