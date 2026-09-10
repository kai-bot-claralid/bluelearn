// Pure backup/import logic: validating untrusted JSON and merging libraries, kept UI-free
// so it can run under `node --test` and be reused for both file import and localStorage recovery.

import type { Card, Deck } from './study.ts'
import { MIN_EASE, today } from './study.ts'

// Bounds exist purely to keep a hostile or garbled file from freezing the tab while it's parsed.
export const MAX_DECKS = 1000
export const MAX_CARDS_PER_DECK = 5000
export const MAX_TOTAL_CARDS = 20_000
export const MAX_TEXT_LENGTH = 20_000
export const MAX_TITLE_LENGTH = 300
export const MAX_EASE = 10

const MIN_DATE_MS = Date.UTC(2000, 0, 1)
const MAX_DATE_MS = Date.UTC(2100, 0, 1)

export type MergeStats = { addedDecks: number; updatedDecks: number; addedCards: number; updatedCards: number }

export type StoredLibraryResult =
  | { status: 'empty' }
  | { status: 'ok'; decks: Deck[] }
  | { status: 'corrupted'; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function validateBackup(data: unknown): { ok: true; decks: Deck[] } | { ok: false; error: string } {
  const list = Array.isArray(data) ? data : isRecord(data) ? data.decks : undefined
  if (!Array.isArray(list)) return { ok: false, error: 'El archivo no tiene el formato de backup de Bluelearn (falta la lista de mazos).' }
  if (list.length > MAX_DECKS) return { ok: false, error: `El archivo tiene demasiados mazos (${list.length}). Bluelearn admite hasta ${MAX_DECKS} mazos por backup.` }

  const decks: Deck[] = []
  const seenDeckIds = new Set<string>()
  const seenCardIds = new Set<string>()
  let totalCards = 0

  for (let i = 0; i < list.length; i++) {
    const rawDeck = list[i]
    if (!isRecord(rawDeck)) return { ok: false, error: `El mazo #${i + 1} no es un objeto válido.` }
    const { id, title, category, cards } = rawDeck
    if (typeof id !== 'string' || !id) return { ok: false, error: `El mazo #${i + 1} no tiene un "id" válido.` }
    if (seenDeckIds.has(id)) return { ok: false, error: `Hay más de un mazo con el id "${id}". Cada mazo debe tener un id único.` }
    seenDeckIds.add(id)
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: `El mazo #${i + 1} no tiene un "title" válido.` }
    if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `El nombre del mazo #${i + 1} es demasiado largo.` }
    if (category !== undefined && typeof category !== 'string') return { ok: false, error: `La categoría del mazo "${title}" no es válida.` }
    if (typeof category === 'string' && category.length > MAX_TITLE_LENGTH) return { ok: false, error: `La categoría del mazo "${title}" es demasiado larga.` }
    if (!Array.isArray(cards)) return { ok: false, error: `El mazo "${title}" no tiene una lista de tarjetas válida.` }
    if (cards.length > MAX_CARDS_PER_DECK) return { ok: false, error: `El mazo "${title}" tiene demasiadas tarjetas (${cards.length}). El máximo por mazo es ${MAX_CARDS_PER_DECK}.` }

    const validCards: Card[] = []
    for (let j = 0; j < cards.length; j++) {
      const rawCard = cards[j]
      if (!isRecord(rawCard)) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no es un objeto válido.` }
      const { id: cardId, front, back } = rawCard
      if (typeof cardId !== 'string' || !cardId) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene un "id" válido.` }
      if (seenCardIds.has(cardId)) return { ok: false, error: `Hay más de una tarjeta con el id "${cardId}" (mazo "${title}"). Cada tarjeta debe tener un id único en todo el archivo.` }
      seenCardIds.add(cardId)
      if (typeof front !== 'string' || !front.trim()) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene una pregunta ("front") válida.` }
      if (front.length > MAX_TEXT_LENGTH) return { ok: false, error: `La pregunta de una tarjeta en "${title}" es demasiado larga.` }
      if (typeof back !== 'string' || !back.trim()) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene una respuesta ("back") válida.` }
      if (back.length > MAX_TEXT_LENGTH) return { ok: false, error: `La respuesta de una tarjeta en "${title}" es demasiado larga.` }
      if (rawCard.description !== undefined && typeof rawCard.description !== 'string') return { ok: false, error: `La descripción de una tarjeta en "${title}" no es válida.` }
      if (typeof rawCard.description === 'string' && rawCard.description.length > MAX_TEXT_LENGTH) return { ok: false, error: `La descripción de una tarjeta en "${title}" es demasiado larga.` }
      if (rawCard.image !== undefined && typeof rawCard.image !== 'string') return { ok: false, error: `La imagen de una tarjeta en "${title}" no es válida.` }
      if (typeof rawCard.image === 'string' && rawCard.image.length > MAX_TEXT_LENGTH) return { ok: false, error: `La imagen de una tarjeta en "${title}" es demasiado larga.` }

      if (rawCard.interval !== undefined) {
        if (typeof rawCard.interval !== 'number' || !Number.isFinite(rawCard.interval)) return { ok: false, error: `El intervalo de repaso de una tarjeta en "${title}" no es un número válido.` }
        if (rawCard.interval < 0) return { ok: false, error: `El intervalo de repaso de una tarjeta en "${title}" no puede ser negativo.` }
      }
      if (rawCard.ease !== undefined) {
        if (typeof rawCard.ease !== 'number' || !Number.isFinite(rawCard.ease)) return { ok: false, error: `El factor de facilidad de una tarjeta en "${title}" no es un número válido.` }
        if (rawCard.ease < MIN_EASE || rawCard.ease > MAX_EASE) return { ok: false, error: `El factor de facilidad de una tarjeta en "${title}" está fuera de un rango razonable (${MIN_EASE}–${MAX_EASE}).` }
      }
      let nextReview = today()
      if (rawCard.nextReview !== undefined) {
        if (typeof rawCard.nextReview !== 'string') return { ok: false, error: `La fecha de repaso de una tarjeta en "${title}" no es válida.` }
        const time = new Date(rawCard.nextReview).getTime()
        if (Number.isNaN(time) || time < MIN_DATE_MS || time > MAX_DATE_MS) return { ok: false, error: `La fecha de repaso de una tarjeta en "${title}" es imposible.` }
        nextReview = rawCard.nextReview
      }

      validCards.push({
        id: cardId, front, back,
        description: typeof rawCard.description === 'string' ? rawCard.description : '',
        image: typeof rawCard.image === 'string' && rawCard.image ? rawCard.image : undefined,
        nextReview,
        interval: typeof rawCard.interval === 'number' ? rawCard.interval : 0,
        ease: typeof rawCard.ease === 'number' ? rawCard.ease : 2.5,
      })
      totalCards++
      if (totalCards > MAX_TOTAL_CARDS) return { ok: false, error: `El archivo tiene demasiadas tarjetas en total (más de ${MAX_TOTAL_CARDS}). Divide el backup en archivos más pequeños.` }
    }
    decks.push({
      id, title,
      category: typeof category === 'string' && category.trim() ? category : 'General',
      color: '',
      cards: validCards,
      isDemo: typeof rawDeck.isDemo === 'boolean' ? rawDeck.isDemo : undefined,
    })
  }
  return { ok: true, decks }
}

// A deck id match overwrites cards that exist in both, and keeps everything else untouched —
// nothing local is ever dropped, so the caller can report exactly what changed instead of
// merging silently.
export function mergeDecks(local: Deck[], incoming: Deck[]): { decks: Deck[]; stats: MergeStats } {
  const merged = [...local]
  const stats: MergeStats = { addedDecks: 0, updatedDecks: 0, addedCards: 0, updatedCards: 0 }
  for (const incomingDeck of incoming) {
    const existingIndex = merged.findIndex(item => item.id === incomingDeck.id)
    if (existingIndex === -1) {
      merged.push(incomingDeck)
      stats.addedDecks++
      stats.addedCards += incomingDeck.cards.length
      continue
    }
    const existing = merged[existingIndex]
    const cardMap = new Map(existing.cards.map(card => [card.id, card]))
    let deckTouched = false
    for (const card of incomingDeck.cards) {
      if (cardMap.has(card.id)) stats.updatedCards++
      else stats.addedCards++
      cardMap.set(card.id, card)
      deckTouched = true
    }
    if (deckTouched) stats.updatedDecks++
    merged[existingIndex] = { ...existing, cards: [...cardMap.values()] }
  }
  return { decks: merged, stats }
}

// Used both to read the persisted library on boot and (indirectly) to decide whether recovery
// is needed: `corrupted` is only ever a parse/shape failure, never "no library yet".
export function parseStoredLibrary(raw: string | null): StoredLibraryResult {
  if (raw === null) return { status: 'empty' }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { return { status: 'corrupted', error: 'El contenido guardado no es JSON válido.' } }
  const result = validateBackup(parsed)
  if (!result.ok) return { status: 'corrupted', error: result.error }
  return { status: 'ok', decks: result.decks }
}
