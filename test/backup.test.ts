import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CARDS_PER_DECK,
  MAX_DECKS,
  MAX_EASE,
  MAX_TOTAL_CARDS,
  mergeDecks,
  parseStoredLibrary,
  validateBackup,
} from '../src/backup.ts'
import type { Deck } from '../src/study.ts'
import { MIN_EASE } from '../src/study.ts'

function makeCard(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id, front: `front-${id}`, back: `back-${id}`, description: '',
    nextReview: new Date().toISOString(), interval: 0, ease: 2.5,
    ...overrides,
  }
}

function makeDeck(id: string, cards: unknown[], overrides: Partial<Record<string, unknown>> = {}) {
  return { id, title: id, category: 'General', cards, ...overrides }
}

function typedDeck(id: string, cards: ReturnType<typeof makeCard>[]): Deck {
  return { id, title: id, category: 'General', color: '#000', cards: cards as Deck['cards'] }
}

describe('validateBackup — compatibility with existing formats', () => {
  test('accepts the bare-array format used before the version wrapper existed', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1')])])
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.decks.length, 1)
  })

  test('accepts the versioned { version, decks } object produced by the current export', () => {
    const result = validateBackup({ version: 1, exportedAt: new Date().toISOString(), decks: [makeDeck('a', [makeCard('c1')])] })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.decks[0].id, 'a')
  })

  test('fills in sensible defaults when optional card fields are missing', () => {
    const result = validateBackup([makeDeck('a', [{ id: 'c1', front: 'q', back: 'a' }])])
    assert.equal(result.ok, true)
    if (result.ok) {
      const card = result.decks[0].cards[0]
      assert.equal(card.interval, 0)
      assert.equal(card.ease, 2.5)
      assert.equal(card.description, '')
      assert.equal(typeof card.nextReview, 'string')
    }
  })

  test('defaults a missing category to "General"', () => {
    const result = validateBackup([{ id: 'a', title: 'A', cards: [] }])
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.decks[0].category, 'General')
  })
})

describe('validateBackup — structural errors', () => {
  test('rejects data with no deck list at all', () => {
    const result = validateBackup({ notDecks: [] })
    assert.equal(result.ok, false)
  })

  test('rejects a deck that is not an object', () => {
    const result = validateBackup(['not-a-deck'])
    assert.equal(result.ok, false)
  })

  test('rejects a deck missing an id', () => {
    const result = validateBackup([{ title: 'A', cards: [] }])
    assert.equal(result.ok, false)
  })

  test('rejects a deck missing a title', () => {
    const result = validateBackup([{ id: 'a', cards: [] }])
    assert.equal(result.ok, false)
  })

  test('rejects a deck whose cards field is not an array', () => {
    const result = validateBackup([{ id: 'a', title: 'A', cards: 'nope' }])
    assert.equal(result.ok, false)
  })

  test('rejects a card that is not an object', () => {
    const result = validateBackup([makeDeck('a', ['not-a-card'])])
    assert.equal(result.ok, false)
  })

  test('rejects a card missing front/back', () => {
    const result = validateBackup([makeDeck('a', [{ id: 'c1', front: '', back: 'a' }])])
    assert.equal(result.ok, false)
  })
})

describe('validateBackup — duplicate ids', () => {
  test('rejects two decks sharing the same id', () => {
    const result = validateBackup([makeDeck('a', []), makeDeck('a', [])])
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /id/i)
  })

  test('rejects two cards sharing the same id, even across different decks', () => {
    const result = validateBackup([
      makeDeck('a', [makeCard('shared')]),
      makeDeck('b', [makeCard('shared')]),
    ])
    assert.equal(result.ok, false)
  })

  test('accepts distinct ids across decks and cards', () => {
    const result = validateBackup([
      makeDeck('a', [makeCard('a1'), makeCard('a2')]),
      makeDeck('b', [makeCard('b1')]),
    ])
    assert.equal(result.ok, true)
  })
})

describe('validateBackup — numeric and date ranges', () => {
  test('rejects a negative interval', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { interval: -5 })])])
    assert.equal(result.ok, false)
  })

  test('rejects a non-finite interval', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { interval: Infinity })])])
    assert.equal(result.ok, false)
  })

  test('rejects an ease below the minimum', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { ease: MIN_EASE - 0.1 })])])
    assert.equal(result.ok, false)
  })

  test('rejects an ease above the reasonable maximum', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { ease: MAX_EASE + 1 })])])
    assert.equal(result.ok, false)
  })

  test('rejects a NaN ease', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { ease: NaN })])])
    assert.equal(result.ok, false)
  })

  test('accepts ease at the exact boundaries', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { ease: MIN_EASE }), makeCard('c2', { ease: MAX_EASE })])])
    assert.equal(result.ok, true)
  })

  test('rejects a nextReview that is not a parseable date', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { nextReview: 'not-a-date' })])])
    assert.equal(result.ok, false)
  })

  test('rejects a nextReview far in the past (impossible for this app)', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { nextReview: '1800-01-01T00:00:00.000Z' })])])
    assert.equal(result.ok, false)
  })

  test('rejects a nextReview far in the future', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { nextReview: '3000-01-01T00:00:00.000Z' })])])
    assert.equal(result.ok, false)
  })
})

describe('validateBackup — size limits', () => {
  test('rejects a backup with more decks than the supported maximum', () => {
    const decks = Array.from({ length: MAX_DECKS + 1 }, (_, i) => makeDeck(`d${i}`, []))
    const result = validateBackup(decks)
    assert.equal(result.ok, false)
  })

  test('rejects a single deck with more cards than the supported maximum', () => {
    const cards = Array.from({ length: MAX_CARDS_PER_DECK + 1 }, (_, i) => makeCard(`c${i}`))
    const result = validateBackup([makeDeck('a', cards)])
    assert.equal(result.ok, false)
  })

  test('rejects a backup whose total card count exceeds the supported maximum, spread across many decks', () => {
    const perDeck = 2000
    const deckCount = Math.floor(MAX_TOTAL_CARDS / perDeck) + 2
    const decks = Array.from({ length: deckCount }, (_, i) =>
      makeDeck(`d${i}`, Array.from({ length: perDeck }, (_, j) => makeCard(`d${i}-c${j}`))))
    const result = validateBackup(decks)
    assert.equal(result.ok, false)
  })

  test('rejects an excessively long card field', () => {
    const result = validateBackup([makeDeck('a', [makeCard('c1', { front: 'x'.repeat(20_001) })])])
    assert.equal(result.ok, false)
  })
})

describe('parseStoredLibrary', () => {
  test('reports "empty" when nothing has ever been saved', () => {
    assert.deepEqual(parseStoredLibrary(null), { status: 'empty' })
  })

  test('reports "corrupted" for text that is not valid JSON, without losing the raw content', () => {
    const raw = '{not json at all'
    const result = parseStoredLibrary(raw)
    assert.equal(result.status, 'corrupted')
  })

  test('reports "corrupted" for JSON that does not match the Bluelearn shape', () => {
    const result = parseStoredLibrary(JSON.stringify({ hello: 'world' }))
    assert.equal(result.status, 'corrupted')
  })

  test('reports "corrupted" for a backup with structurally invalid content (e.g. duplicate ids)', () => {
    const raw = JSON.stringify([makeDeck('a', []), makeDeck('a', [])])
    const result = parseStoredLibrary(raw)
    assert.equal(result.status, 'corrupted')
  })

  test('reports "ok" and returns decks for a valid saved library', () => {
    const raw = JSON.stringify([makeDeck('a', [makeCard('c1')])])
    const result = parseStoredLibrary(raw)
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') assert.equal(result.decks.length, 1)
  })
})

describe('mergeDecks', () => {
  test('adds a deck that does not exist locally yet', () => {
    const local: Deck[] = []
    const incoming = [typedDeck('a', [makeCard('c1') as never])]
    const { decks, stats } = mergeDecks(local, incoming)
    assert.equal(decks.length, 1)
    assert.equal(stats.addedDecks, 1)
    assert.equal(stats.addedCards, 1)
    assert.equal(stats.updatedDecks, 0)
  })

  test('never drops a local card that the incoming deck does not mention', () => {
    const local = [typedDeck('a', [makeCard('local-only') as never])]
    const incoming = [typedDeck('a', [makeCard('new-card') as never])]
    const { decks, stats } = mergeDecks(local, incoming)
    const ids = decks[0].cards.map(c => c.id).sort()
    assert.deepEqual(ids, ['local-only', 'new-card'])
    assert.equal(stats.addedCards, 1)
    assert.equal(stats.updatedCards, 0)
  })

  test('overwrites a card whose id collides, and reports it as updated (not added)', () => {
    const local = [typedDeck('a', [makeCard('shared', { front: 'old question' }) as never])]
    const incoming = [typedDeck('a', [makeCard('shared', { front: 'new question' }) as never])]
    const { decks, stats } = mergeDecks(local, incoming)
    assert.equal(decks[0].cards.length, 1)
    assert.equal(decks[0].cards[0].front, 'new question')
    assert.equal(stats.updatedCards, 1)
    assert.equal(stats.addedCards, 0)
  })

  test('leaves an unrelated local deck completely untouched', () => {
    const local = [typedDeck('untouched', [makeCard('u1') as never])]
    const incoming = [typedDeck('other', [makeCard('o1') as never])]
    const { decks } = mergeDecks(local, incoming)
    const untouched = decks.find(d => d.id === 'untouched')
    assert.deepEqual(untouched, local[0])
  })

  test('does not count a matched deck as updated when the incoming deck brings no cards', () => {
    const local = [typedDeck('a', [makeCard('c1') as never])]
    const incoming = [typedDeck('a', [])]
    const { stats } = mergeDecks(local, incoming)
    assert.equal(stats.updatedDecks, 0)
  })
})
