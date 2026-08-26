import { Card, Design, backfill } from './types'
import { CARDS } from './cards'

// bumped when a change to the saved shape cannot be detected from the data itself.
// 2026-08-17: prize amounts moved from whole tokens to real base units.
const KEY = 'sheet:draft:v2'

const saved = import.meta.glob<{ default: Card[] }>('../../cards.json', { eager: true })
const design = import.meta.glob<{ default: Design }>('../../design.json', { eager: true })

/** What is on disk, or the built-in conversion of today's sheet if nothing has been saved. */
export const onDisk = (): Card[] => {
  const mod = Object.values(saved)[0]
  return mod?.default?.length ? backfill(structuredClone(mod.default)) : structuredClone(CARDS)
}

/** The seed the tool ships with — today's five cards restated in the new format. */
export const seed = (): Card[] => structuredClone(CARDS)

/** Ladder settings per card id — the tool's own state, never part of a published config. */
export const designOnDisk = (): Design =>
  structuredClone(Object.values(design)[0]?.default ?? {})

const DESIGN_KEY = 'sheet:design'
const PICK_KEY = 'sheet:pick'

/** Which card was open. Vite reloads the page whenever cards.json changes on disk. */
export const readPick = (): number => {
  const n = Number(localStorage.getItem(PICK_KEY))
  return Number.isInteger(n) && n >= 0 ? n : 0
}

export const writePick = (i: number) => {
  try { localStorage.setItem(PICK_KEY, String(i)) } catch { /* ignore */ }
}

export function readDesign(): Design | null {
  try {
    const text = localStorage.getItem(DESIGN_KEY)
    return text ? (JSON.parse(text) as Design) : null
  } catch {
    return null
  }
}

export const writeDesign = (d: Design) => {
  try { localStorage.setItem(DESIGN_KEY, JSON.stringify(d)) } catch { /* ignore */ }
}

export const clearDesign = () => {
  try { localStorage.removeItem(DESIGN_KEY) } catch { /* ignore */ }
}

export async function saveDesign(d: Design): Promise<void> {
  await fetch('/__sheet/design', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(d, null, 2),
  })
}

export function readDraft(): Card[] | null {
  try {
    const text = localStorage.getItem(KEY)
    if (!text) return null
    const cards = JSON.parse(text) as Card[]
    // a draft written before a field existed is as old as anything on disk
    return Array.isArray(cards) && cards.length ? backfill(cards) : null
  } catch {
    return null
  }
}

export const writeDraft = (cards: Card[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(cards)) } catch { /* quota, private mode */ }
}

export const clearDraft = () => {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export async function saveToDisk(cards: Card[]): Promise<string> {
  const res = await fetch('/__sheet/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cards, null, 2),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.ok) throw new Error(body.error ?? `save failed (${res.status})`)
  return body.path as string
}

export const same = (a: Card[], b: Card[]) => JSON.stringify(a) === JSON.stringify(b)

/** Reads an uploaded sheet, refusing anything that would leave the app in a broken state. */
export function parseSheet(text: string): Card[] {
  const data = JSON.parse(text)
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('expected a non-empty array of cards')
  }
  data.forEach((c, i) => {
    const where = `card ${i}${typeof c?.id === 'string' ? ` (${c.id})` : ''}`
    if (typeof c?.id !== 'string') throw new Error(`${where}: missing id`)
    if (c.mode !== 'count' && c.mode !== 'compare') throw new Error(`${where}: mode must be count or compare`)
    if (typeof c.priceLamports !== 'number') throw new Error(`${where}: missing priceLamports`)
    for (const key of ['blocks', 'pays', 'pool', 'tiers'] as const) {
      if (!Array.isArray(c[key])) throw new Error(`${where}: ${key} must be an array`)
    }
    if (!Array.isArray(c.modeArgs) || c.modeArgs.length !== 4) {
      throw new Error(`${where}: modeArgs must be four numbers`)
    }
  })
  return backfill(data as Card[])
}
