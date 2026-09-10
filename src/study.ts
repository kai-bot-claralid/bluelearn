// Pure spaced-repetition study session logic, kept UI-free so it can run under `node --test`.

export type Card = {
  id: string
  front: string
  back: string
  description: string
  image?: string
  nextReview: string
  interval: number
  ease: number
}

export type Deck = {
  id: string
  title: string
  category: string
  color: string
  cards: Card[]
  isDemo?: boolean
}

export type StudyItem = { deckId: string; cardId: string }
export type Rating = 'again' | 'hard' | 'good' | 'easy'
export type SessionAnswer = { cardId: string; deckId: string; front: string; rating: Rating; nextReview: string }

export const DAY = 86_400_000
export const MIN_EASE = 1.3
export const EASE_DELTA: Record<Rating, number> = { again: -0.3, hard: -0.15, good: 0, easy: 0.15 }
export const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy']
// Same-session "otra vez" retries: how many extra chances a card gets, and how far back in the queue it reappears.
export const SESSION_RETRY_LIMIT = 2
export const RETRY_GAP = 3

export function scheduleCard(card: Card, rating: Rating) {
  const ease = Math.round(Math.max(MIN_EASE, card.ease + EASE_DELTA[rating]) * 100) / 100
  const base = card.interval || 1
  let days: number
  if (rating === 'again') days = 0
  else if (rating === 'hard') days = Math.max(1, base * 1.2)
  else if (rating === 'good') days = card.interval ? base * ease : 1
  else days = Math.max(4, (card.interval ? base * ease : 4) * 1.3)
  days = Math.round(days * 100) / 100
  const dueInMs = rating === 'again' ? 10 * 60_000 : days * DAY
  return { interval: days, ease, dueInMs }
}

export function isDue(nextReview: string, now: number) {
  return new Date(nextReview).getTime() <= now
}

// A deck can always be practiced once it has cards: due cards when some are pending,
// otherwise every card in scope so studying is never blocked on the schedule.
export function buildStudyQueue(decks: Deck[], deckId?: string, practiceAll = false, now = Date.now()): StudyItem[] {
  return decks.flatMap(item => item.cards
    .filter(card => (!deckId || item.id === deckId) && (practiceAll || isDue(card.nextReview, now)))
    .map(card => ({ deckId: item.id, cardId: card.id })))
}

export function scheduleRetry(queue: StudyItem[], studyIndex: number, item: StudyItem, attempts: number): { queue: StudyItem[]; requeued: boolean } {
  if (attempts >= SESSION_RETRY_LIMIT) return { queue, requeued: false }
  const gap = Math.max(1, Math.min(RETRY_GAP, queue.length - studyIndex - 1))
  const insertAt = Math.min(queue.length, studyIndex + 1 + gap)
  return { queue: [...queue.slice(0, insertAt), item, ...queue.slice(insertAt)], requeued: true }
}

// Progress is reported against the count of *distinct* cards, not queue.length, so a same-session
// "otra vez" requeue (which grows the queue) never makes the total look like new cards appeared.
export function computeProgress(queue: StudyItem[], studyIndex: number) {
  const totalCards = new Set(queue.map(entry => entry.cardId)).size
  const upper = Math.min(studyIndex, queue.length - 1)
  const seen = new Set<string>()
  for (let i = 0; i <= upper; i++) seen.add(queue[i].cardId)
  const distinctSeen = seen.size
  const repeats = upper + 1 - distinctSeen
  return { distinctSeen, totalCards, repeats }
}

export function computeSessionSummary(sessionAnswers: SessionAnswer[]) {
  const lastByCard = new Map<string, SessionAnswer>()
  for (const answer of sessionAnswers) lastByCard.set(answer.cardId, answer)
  const finalAnswers = [...lastByCard.values()]
  const distribution: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 }
  for (const answer of sessionAnswers) distribution[answer.rating]++
  // A card that ever scored "otra vez"/"difícil" belongs in reinforcement even if a later
  // pass in the same session ended on "bien"/"fácil" — the struggle happened either way.
  const reinforcementIds = new Set(
    sessionAnswers.filter(answer => answer.rating === 'again' || answer.rating === 'hard').map(answer => answer.cardId),
  )
  const reinforcement = finalAnswers.filter(answer => reinforcementIds.has(answer.cardId))
  const meaningful = finalAnswers.filter(answer => answer.rating !== 'again')
  const earliestNext = meaningful.length ? Math.min(...meaningful.map(answer => new Date(answer.nextReview).getTime())) : null
  return { uniqueCards: finalAnswers.length, totalAnswers: sessionAnswers.length, distribution, reinforcement, earliestNext }
}
