import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStudyQueue,
  computeProgress,
  computeSessionSummary,
  scheduleRetry,
} from '../src/study.ts'
import type { Deck, SessionAnswer, StudyItem } from '../src/study.ts'

function makeCard(id: string, overrides: Partial<{ nextReview: string; interval: number; ease: number }> = {}) {
  return {
    id,
    front: `front-${id}`,
    back: `back-${id}`,
    description: '',
    nextReview: overrides.nextReview ?? new Date(Date.now() - 1000).toISOString(),
    interval: overrides.interval ?? 0,
    ease: overrides.ease ?? 2.5,
  }
}

function makeDeck(id: string, cards: ReturnType<typeof makeCard>[]): Deck {
  return { id, title: id, category: 'General', color: '#000', cards }
}

const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

describe('buildStudyQueue', () => {
  test('a deck with cards can always be practiced, even with nothing due', () => {
    const decks = [makeDeck('a', [makeCard('c1', { nextReview: FUTURE }), makeCard('c2', { nextReview: FUTURE })])]
    assert.equal(buildStudyQueue(decks, 'a', false).length, 0)
    const all = buildStudyQueue(decks, 'a', true)
    assert.equal(all.length, 2)
  })

  test('"Repasar ahora" (practiceAll=false) studies only due cards when some exist', () => {
    const decks = [makeDeck('a', [makeCard('due', { nextReview: PAST }), makeCard('notdue', { nextReview: FUTURE })])]
    const queue = buildStudyQueue(decks, 'a', false)
    assert.deepEqual(queue.map(item => item.cardId), ['due'])
  })

  test('single-deck session only includes that deck\'s cards', () => {
    const decks = [
      makeDeck('a', [makeCard('a1', { nextReview: PAST })]),
      makeDeck('b', [makeCard('b1', { nextReview: PAST })]),
    ]
    const queue = buildStudyQueue(decks, 'a', false)
    assert.deepEqual(queue, [{ deckId: 'a', cardId: 'a1' }])
  })

  test('global session (no deckId) spans every deck', () => {
    const decks = [
      makeDeck('a', [makeCard('a1', { nextReview: PAST })]),
      makeDeck('b', [makeCard('b1', { nextReview: PAST })]),
    ]
    const queue = buildStudyQueue(decks, undefined, false)
    assert.deepEqual(queue.map(item => item.cardId).sort(), ['a1', 'b1'])
  })
})

describe('scheduleRetry', () => {
  test('requeues an "otra vez" card without growing the set of distinct cards', () => {
    const queue: StudyItem[] = [{ deckId: 'a', cardId: 'c1' }, { deckId: 'a', cardId: 'c2' }, { deckId: 'a', cardId: 'c3' }]
    const result = scheduleRetry(queue, 0, queue[0], 0)
    assert.equal(result.requeued, true)
    assert.equal(result.queue.length, 4)
    assert.equal(new Set(result.queue.map(i => i.cardId)).size, 3)
  })

  test('stops requeuing once the session retry limit is reached', () => {
    const queue: StudyItem[] = [{ deckId: 'a', cardId: 'c1' }]
    const result = scheduleRetry(queue, 0, queue[0], 2)
    assert.equal(result.requeued, false)
    assert.equal(result.queue, queue)
  })
})

describe('computeProgress', () => {
  test('single card session reports 1 of 1 with no repeats', () => {
    const queue: StudyItem[] = [{ deckId: 'a', cardId: 'c1' }]
    assert.deepEqual(computeProgress(queue, 0), { distinctSeen: 1, totalCards: 1, repeats: 0 })
  })

  test('repeated "otra vez" keeps the total stable and reports repeats separately', () => {
    let queue: StudyItem[] = [{ deckId: 'a', cardId: 'c1' }, { deckId: 'a', cardId: 'c2' }]
    // c1 answered "again" at index 0, gets requeued.
    const retry = scheduleRetry(queue, 0, queue[0], 0)
    queue = retry.queue
    // Now on the reinserted c1 at whatever index it landed.
    const c1RetryIndex = queue.findIndex((item, index) => item.cardId === 'c1' && index > 0)
    const progress = computeProgress(queue, c1RetryIndex)
    assert.equal(progress.totalCards, 2, 'total stays at the original distinct card count')
    assert.equal(progress.distinctSeen, 2, 'both original cards have been seen by this point')
    assert.equal(progress.repeats, 1, 'the extra pass over c1 is reported as a repeat, not a new card')
  })

  test('multi-card session mid-way through reports partial progress', () => {
    const queue: StudyItem[] = [{ deckId: 'a', cardId: 'c1' }, { deckId: 'a', cardId: 'c2' }, { deckId: 'a', cardId: 'c3' }]
    assert.deepEqual(computeProgress(queue, 1), { distinctSeen: 2, totalCards: 3, repeats: 0 })
  })
})

describe('computeSessionSummary', () => {
  function answer(cardId: string, rating: SessionAnswer['rating'], nextReview = new Date().toISOString()): SessionAnswer {
    return { cardId, deckId: 'a', front: `front-${cardId}`, rating, nextReview }
  }

  test('a card that ever scored "otra vez" stays in reinforcement even if it later ends on "bien"', () => {
    const summary = computeSessionSummary([answer('c1', 'again'), answer('c1', 'good')])
    assert.equal(summary.reinforcement.length, 1)
    assert.equal(summary.reinforcement[0].cardId, 'c1')
    assert.equal(summary.reinforcement[0].rating, 'good', 'the entry reflects the final rating')
  })

  test('a card that ever scored "difícil" stays in reinforcement even after "fácil"', () => {
    const summary = computeSessionSummary([answer('c1', 'hard'), answer('c1', 'easy')])
    assert.equal(summary.reinforcement.length, 1)
  })

  test('reinforcement never duplicates a card, even with multiple "otra vez" passes', () => {
    const summary = computeSessionSummary([answer('c1', 'again'), answer('c1', 'again'), answer('c1', 'good')])
    assert.equal(summary.reinforcement.length, 1)
  })

  test('a card that always scored well is excluded from reinforcement', () => {
    const summary = computeSessionSummary([answer('c1', 'good'), answer('c2', 'easy')])
    assert.equal(summary.reinforcement.length, 0)
  })

  test('distinguishes unique cards from total answers when a card repeats', () => {
    const summary = computeSessionSummary([answer('c1', 'again'), answer('c1', 'good'), answer('c2', 'good')])
    assert.equal(summary.uniqueCards, 2)
    assert.equal(summary.totalAnswers, 3)
  })

  test('earliestNext ignores "otra vez" answers (they are not a real completion)', () => {
    const soon = new Date(Date.now() + 1000).toISOString()
    const later = new Date(Date.now() + 86_400_000).toISOString()
    const summary = computeSessionSummary([
      { cardId: 'c1', deckId: 'a', front: 'f1', rating: 'again', nextReview: new Date(Date.now() + 1).toISOString() },
      { cardId: 'c1', deckId: 'a', front: 'f1', rating: 'good', nextReview: soon },
      { cardId: 'c2', deckId: 'a', front: 'f2', rating: 'easy', nextReview: later },
    ])
    assert.equal(summary.earliestNext, new Date(soon).getTime())
  })
})
