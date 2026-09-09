import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import './App.css'

type Card = {
  id: string
  front: string
  back: string
  description: string
  image?: string
  nextReview: string
  interval: number
  ease: number
}

type Deck = {
  id: string
  title: string
  category: string
  color: string
  cards: Card[]
}

type StudyItem = { deckId: string; cardId: string }
type Rating = 'again' | 'hard' | 'good' | 'easy'
type ImportStrategy = 'merge' | 'replace'
type SessionAnswer = { cardId: string; deckId: string; front: string; rating: Rating; nextReview: string }
type DeckModal = { type: 'create' } | { type: 'edit'; deckId: string }
type CardModal = { type: 'create' } | { type: 'edit'; cardId: string }

const DAY = 86_400_000
const COLORS = ['#1769ff', '#ff6b5f', '#f4b942', '#24a47f', '#8b5cf6']
const MIN_EASE = 1.3
const EASE_DELTA: Record<Rating, number> = { again: -0.3, hard: -0.15, good: 0, easy: 0.15 }
const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy']
const RATING_META: Record<Rating, { label: string; icon: string }> = {
  again: { label: 'Otra vez', icon: '↺' },
  hard: { label: 'Difícil', icon: '−' },
  good: { label: 'Bien', icon: '✓' },
  easy: { label: 'Fácil', icon: '✦' },
}
// Same-session "otra vez" retries: how many extra chances a card gets, and how far back in the queue it reappears.
const SESSION_RETRY_LIMIT = 2
const RETRY_GAP = 3
const DUE_REFRESH_MS = 20_000

const starterDecks: Deck[] = [
  {
    id: 'biology', title: 'Biología celular', category: 'Ciencias', color: '#24a47f',
    cards: [
      { id: 'mitochondria', front: '¿Cuál es la función de la mitocondria?', back: 'Producir ATP mediante la respiración celular.', description: 'Es el orgánulo que convierte la energía química de los nutrientes en energía utilizable por la célula.', image: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Mitochondria%2C_mammalian_lung_-_TEM.jpg', nextReview: new Date().toISOString(), interval: 0, ease: 2.5 },
      { id: 'membrane', front: '¿Qué modelo explica la membrana celular?', back: 'El modelo de mosaico fluido.', description: 'Describe una bicapa de fosfolípidos donde proteínas y otras moléculas pueden moverse lateralmente.', nextReview: new Date().toISOString(), interval: 0, ease: 2.5 },
    ],
  },
  { id: 'english', title: 'Inglés cotidiano', category: 'Idiomas', color: '#f4b942', cards: [] },
  { id: 'design', title: 'Fundamentos de diseño', category: 'Creatividad', color: '#ff6b5f', cards: [] },
]

function uid() { return crypto.randomUUID() }
function today() { return new Date().toISOString() }
function withColors(list: Deck[]): Deck[] { return list.map((item, index) => ({ ...item, color: COLORS[index % COLORS.length] })) }

function scheduleCard(card: Card, rating: Rating) {
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

function formatDue(ms: number) {
  const minutes = ms / 60_000
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`
  const hours = ms / 3_600_000
  if (hours < 24) return `${Math.round(hours)} h`
  const days = ms / DAY
  if (days < 30) return `${Math.round(days)} d`
  const months = days / 30
  return months < 12 ? `${Math.round(months)} mes${months >= 2 ? 'es' : ''}` : `${(days / 365).toFixed(1)} años`
}

function dueLabel(nextReview: string) {
  const diff = new Date(nextReview).getTime() - Date.now()
  return diff <= 0 ? 'Hoy' : formatDue(diff)
}

function isDue(nextReview: string, now: number) {
  return new Date(nextReview).getTime() <= now
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateBackup(data: unknown): { ok: true; decks: Deck[] } | { ok: false; error: string } {
  const list = Array.isArray(data) ? data : isRecord(data) ? data.decks : undefined
  if (!Array.isArray(list)) return { ok: false, error: 'El archivo no tiene el formato de backup de Bluelearn (falta la lista de mazos).' }
  const decks: Deck[] = []
  for (let i = 0; i < list.length; i++) {
    const rawDeck = list[i]
    if (!isRecord(rawDeck)) return { ok: false, error: `El mazo #${i + 1} no es un objeto válido.` }
    const { id, title, category, cards } = rawDeck
    if (typeof id !== 'string' || !id) return { ok: false, error: `El mazo #${i + 1} no tiene un "id" válido.` }
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: `El mazo #${i + 1} no tiene un "title" válido.` }
    if (!Array.isArray(cards)) return { ok: false, error: `El mazo "${title}" no tiene una lista de tarjetas válida.` }
    const validCards: Card[] = []
    for (let j = 0; j < cards.length; j++) {
      const rawCard = cards[j]
      if (!isRecord(rawCard)) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no es un objeto válido.` }
      const { id: cardId, front, back } = rawCard
      if (typeof cardId !== 'string' || !cardId) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene un "id" válido.` }
      if (typeof front !== 'string' || !front.trim()) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene una pregunta ("front") válida.` }
      if (typeof back !== 'string' || !back.trim()) return { ok: false, error: `La tarjeta #${j + 1} del mazo "${title}" no tiene una respuesta ("back") válida.` }
      const nextReview = typeof rawCard.nextReview === 'string' && !Number.isNaN(new Date(rawCard.nextReview).getTime()) ? rawCard.nextReview : today()
      validCards.push({
        id: cardId, front, back,
        description: typeof rawCard.description === 'string' ? rawCard.description : '',
        image: typeof rawCard.image === 'string' && rawCard.image ? rawCard.image : undefined,
        nextReview,
        interval: typeof rawCard.interval === 'number' && Number.isFinite(rawCard.interval) ? rawCard.interval : 0,
        ease: typeof rawCard.ease === 'number' && Number.isFinite(rawCard.ease) ? rawCard.ease : 2.5,
      })
    }
    decks.push({
      id, title,
      category: typeof category === 'string' && category.trim() ? category : 'General',
      color: COLORS[0],
      cards: validCards,
    })
  }
  return { ok: true, decks }
}

function mergeDecks(local: Deck[], incoming: Deck[]): Deck[] {
  const merged = [...local]
  for (const incomingDeck of incoming) {
    const existingIndex = merged.findIndex(item => item.id === incomingDeck.id)
    if (existingIndex === -1) { merged.push(incomingDeck); continue }
    const existing = merged[existingIndex]
    const cardMap = new Map(existing.cards.map(card => [card.id, card]))
    for (const card of incomingDeck.cards) cardMap.set(card.id, card)
    merged[existingIndex] = { ...existing, cards: [...cardMap.values()] }
  }
  return merged
}

async function searchCommons(query: string) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6',
    gsrlimit: '8', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '480', format: 'json', origin: '*',
  })
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`)
  if (!response.ok) throw new Error('No pudimos consultar la biblioteca')
  const data = await response.json()
  return Object.values(data.query?.pages ?? {}).map((page: any) => ({
    title: String(page.title).replace(/^File:/, ''),
    url: page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url,
  })).filter((item: { url?: string }) => item.url)
}

function ModalSheet({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <button type="button" className="close" aria-label="Cerrar" onClick={onClose}>✕</button>
        {children}
      </div>
    </div>
  )
}

function App() {
  const [decks, setDecks] = useState<Deck[]>(() => {
    try {
      const saved = localStorage.getItem('bluelearn-decks')
      if (!saved) return starterDecks
      const parsed = JSON.parse(saved)
      return Array.isArray(parsed) ? withColors(parsed) : starterDecks
    } catch { return starterDecks }
  })
  const [activeDeck, setActiveDeck] = useState<string | null>(null)
  const [mode, setMode] = useState<'library' | 'edit' | 'study' | 'complete'>('library')

  const [deckModal, setDeckModal] = useState<DeckModal | null>(null)
  const [deckTitle, setDeckTitle] = useState('')
  const [deckCategory, setDeckCategory] = useState('')
  const [deckFormError, setDeckFormError] = useState<string | null>(null)
  const deckFormInitial = useRef({ title: '', category: '' })
  const deckTitleFieldRef = useRef<HTMLInputElement>(null)

  const [cardModal, setCardModal] = useState<CardModal | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [description, setDescription] = useState('')
  const [selectedImage, setSelectedImage] = useState('')
  const [imageResults, setImageResults] = useState<{title: string, url: string}[]>([])
  const [loadingImages, setLoadingImages] = useState(false)
  const [showEnhancements, setShowEnhancements] = useState(false)
  const [cardFormErrors, setCardFormErrors] = useState<{ front?: string; back?: string }>({})
  const [cardSaved, setCardSaved] = useState(false)
  const cardFormInitial = useRef({ front: '', back: '', description: '', image: '' })
  const frontFieldRef = useRef<HTMLTextAreaElement>(null)
  const addAnotherRef = useRef<HTMLButtonElement>(null)

  const [revealed, setRevealed] = useState(false)
  const [studyIndex, setStudyIndex] = useState(0)
  const [studyQueue, setStudyQueue] = useState<StudyItem[]>([])
  const [sessionAnswers, setSessionAnswers] = useState<SessionAnswer[]>([])
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<Deck[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const retryCounts = useRef<Map<string, number>>(new Map())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => localStorage.setItem('bluelearn-decks', JSON.stringify(decks)), [decks])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), DUE_REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const deck = decks.find(item => item.id === activeDeck)
  const dueCards = useMemo(() => deck?.cards.filter(card => isDue(card.nextReview, now)) ?? [], [deck, now])
  const totalCards = decks.reduce((sum, item) => sum + item.cards.length, 0)
  const totalDue = useMemo(() => decks.flatMap(item => item.cards).filter(card => isDue(card.nextReview, now)).length, [decks, now])
  const studyItem = studyQueue[studyIndex]
  const studyDeck = decks.find(item => item.id === studyItem?.deckId)
  const studyCard = studyDeck?.cards.find(card => card.id === studyItem?.cardId)

  const isDeckFormDirty = deckModal !== null && (deckTitle.trim() !== deckFormInitial.current.title.trim() || deckCategory.trim() !== deckFormInitial.current.category.trim())
  const isCardFormDirty = cardModal !== null && !cardSaved && (
    front.trim() !== cardFormInitial.current.front.trim() ||
    back.trim() !== cardFormInitial.current.back.trim() ||
    description.trim() !== cardFormInitial.current.description.trim() ||
    selectedImage !== cardFormInitial.current.image
  )

  const sessionSummary = useMemo(() => {
    const lastByCard = new Map<string, SessionAnswer>()
    for (const answer of sessionAnswers) lastByCard.set(answer.cardId, answer)
    const finalAnswers = [...lastByCard.values()]
    const distribution: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 }
    for (const answer of sessionAnswers) distribution[answer.rating]++
    const reinforcement = finalAnswers.filter(answer => answer.rating === 'again' || answer.rating === 'hard')
    const meaningful = finalAnswers.filter(answer => answer.rating !== 'again')
    const earliestNext = meaningful.length ? Math.min(...meaningful.map(answer => new Date(answer.nextReview).getTime())) : null
    return { uniqueCards: finalAnswers.length, totalAnswers: sessionAnswers.length, distribution, reinforcement, earliestNext }
  }, [sessionAnswers])

  useEffect(() => {
    const dirty = isDeckFormDirty || isCardFormDirty
    if (!dirty) return
    function handleBeforeUnload(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isDeckFormDirty, isCardFormDirty])

  useEffect(() => {
    const open = deckModal !== null || cardModal !== null
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [deckModal, cardModal])

  useEffect(() => { if (deckModal) deckTitleFieldRef.current?.focus() }, [deckModal])
  useEffect(() => { if (cardModal && !cardSaved) frontFieldRef.current?.focus() }, [cardModal, cardSaved])
  useEffect(() => { if (cardSaved) addAnotherRef.current?.focus() }, [cardSaved])

  function confirmDiscardChanges() {
    if (isDeckFormDirty && !window.confirm('Tienes cambios sin guardar en el mazo. ¿Quieres descartarlos?')) return false
    if (isCardFormDirty && !window.confirm('Tienes cambios sin guardar en la tarjeta. ¿Quieres descartarlos?')) return false
    return true
  }

  function openCreateDeck() {
    deckFormInitial.current = { title: '', category: '' }
    setDeckTitle(''); setDeckCategory(''); setDeckFormError(null)
    setDeckModal({ type: 'create' })
  }

  function openEditDeck(target: Deck) {
    deckFormInitial.current = { title: target.title, category: target.category }
    setDeckTitle(target.title); setDeckCategory(target.category); setDeckFormError(null)
    setDeckModal({ type: 'edit', deckId: target.id })
  }

  function resetDeckForm() {
    setDeckModal(null); setDeckTitle(''); setDeckCategory(''); setDeckFormError(null)
    deckFormInitial.current = { title: '', category: '' }
  }

  function requestCloseDeckModal() {
    if (isDeckFormDirty && !window.confirm('Tienes cambios sin guardar en el mazo. ¿Quieres descartarlos?')) return
    resetDeckForm()
  }

  function submitDeckForm(event: FormEvent) {
    event.preventDefault()
    const title = deckTitle.trim()
    if (!title) { setDeckFormError('Ponle un nombre al mazo para continuar.'); deckTitleFieldRef.current?.focus(); return }
    if (deckModal?.type === 'edit') {
      const id = deckModal.deckId
      setDecks(current => current.map(item => item.id === id ? { ...item, title, category: deckCategory.trim() || 'General' } : item))
      resetDeckForm()
    } else {
      const fresh: Deck = { id: uid(), title, category: deckCategory.trim() || 'General', color: COLORS[decks.length % COLORS.length], cards: [] }
      setDecks(current => [...current, fresh])
      resetDeckForm()
      setActiveDeck(fresh.id); setMode('edit')
    }
  }

  function handleDeleteDeck(target: Deck) {
    if (!window.confirm(`¿Eliminar el mazo "${target.title}" y sus ${target.cards.length} tarjetas? Esta acción no se puede deshacer.`)) return
    setDecks(current => current.filter(item => item.id !== target.id))
    if (deckModal?.type === 'edit' && deckModal.deckId === target.id) resetDeckForm()
    if (activeDeck === target.id) goHome()
  }

  function openCreateCard() {
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false)
    setCardModal({ type: 'create' })
  }

  function openEditCard(card: Card) {
    cardFormInitial.current = { front: card.front, back: card.back, description: card.description, image: card.image ?? '' }
    setFront(card.front); setBack(card.back); setDescription(card.description); setSelectedImage(card.image ?? '')
    setImageResults([]); setShowEnhancements(!!(card.description || card.image))
    setCardFormErrors({}); setCardSaved(false)
    setCardModal({ type: 'edit', cardId: card.id })
  }

  function resetCardForm() {
    setCardModal(null)
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false)
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
  }

  function requestCloseCardModal() {
    if (isCardFormDirty && !window.confirm('Tienes cambios sin guardar en la tarjeta. ¿Quieres descartarlos?')) return
    resetCardForm()
  }

  function addAnotherCard() {
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false)
  }

  function studyAfterCardSaved() {
    if (!deck) return
    const deckId = deck.id
    resetCardForm()
    startStudy(deckId)
  }

  function submitCardForm(event: FormEvent) {
    event.preventDefault()
    if (!deck || !cardModal) return
    const errors: { front?: string; back?: string } = {}
    if (!front.trim()) errors.front = 'Escribe la pregunta o concepto que quieres recordar.'
    if (!back.trim()) errors.back = 'Escribe la respuesta de la tarjeta.'
    if (errors.front || errors.back) { setCardFormErrors(errors); return }
    if (cardModal.type === 'edit') {
      const cardId = cardModal.cardId
      setDecks(current => current.map(item => item.id === deck.id
        ? { ...item, cards: item.cards.map(candidate => candidate.id === cardId ? { ...candidate, front: front.trim(), back: back.trim(), description: description.trim(), image: selectedImage || undefined } : candidate) }
        : item))
      resetCardForm()
    } else {
      const card: Card = { id: uid(), front: front.trim(), back: back.trim(), description: description.trim(), image: selectedImage || undefined, nextReview: today(), interval: 0, ease: 2.5 }
      setDecks(current => current.map(item => item.id === deck.id ? { ...item, cards: [...item.cards, card] } : item))
      setNow(Date.now())
      cardFormInitial.current = { front: front.trim(), back: back.trim(), description: description.trim(), image: selectedImage }
      setFront(front.trim()); setBack(back.trim()); setCardFormErrors({})
      setCardSaved(true)
    }
  }

  function handleDeleteCard(card: Card) {
    if (!deck) return
    if (!window.confirm(`¿Eliminar la tarjeta "${card.front}"? Esta acción no se puede deshacer.`)) return
    setDecks(current => current.map(item => item.id === deck.id ? { ...item, cards: item.cards.filter(candidate => candidate.id !== card.id) } : item))
    if (cardModal?.type === 'edit' && cardModal.cardId === card.id) resetCardForm()
  }

  function writeDescription() {
    if (!front && !back) return
    setDescription(`Una explicación breve para recordar que ${back ? back.charAt(0).toLowerCase() + back.slice(1) : front.toLowerCase()}. Relaciónalo con un ejemplo cotidiano para fijarlo mejor.`)
  }

  async function findImages() {
    const query = front || back
    if (!query) return
    setLoadingImages(true)
    try { setImageResults(await searchCommons(query)) }
    catch { setImageResults([]) }
    finally { setLoadingImages(false) }
  }

  function confirmLeaveStudy() {
    if (mode !== 'study') return true
    return window.confirm('¿Salir del repaso? Las tarjetas que ya calificaste quedan guardadas, pero perderás el resumen de esta sesión.')
  }

  function startStudy(deckId?: string) {
    if (!confirmDiscardChanges()) return
    if (!confirmLeaveStudy()) return
    const queue = decks.flatMap(item => item.cards
      .filter(card => (!deckId || item.id === deckId) && new Date(card.nextReview) <= new Date())
      .map(card => ({ deckId: item.id, cardId: card.id })))
    if (!queue.length) return
    if (!deckId) setActiveDeck(null)
    retryCounts.current.clear()
    setSessionAnswers([])
    setStudyQueue(queue); setStudyIndex(0); setRevealed(false); setMode('study')
  }

  function finishSession() {
    setStudyQueue([]); setStudyIndex(0); setRevealed(false); setMode('complete')
  }

  function rateCard(rating: Rating) {
    const card = studyCard
    const item = studyItem
    if (!studyDeck || !card || !item) return
    const { interval, ease, dueInMs } = scheduleCard(card, rating)
    const nextReview = new Date(Date.now() + dueInMs).toISOString()
    setDecks(current => current.map(deckItem => deckItem.id === studyDeck.id
      ? { ...deckItem, cards: deckItem.cards.map(candidate => candidate.id === card.id ? { ...candidate, interval, ease, nextReview } : candidate) }
      : deckItem))
    setSessionAnswers(prev => [...prev, { cardId: card.id, deckId: studyDeck.id, front: card.front, rating, nextReview }])
    setRevealed(false)

    let queue = studyQueue
    if (rating === 'again') {
      const attempts = retryCounts.current.get(card.id) ?? 0
      if (attempts < SESSION_RETRY_LIMIT) {
        retryCounts.current.set(card.id, attempts + 1)
        const gap = Math.max(1, Math.min(RETRY_GAP, queue.length - studyIndex - 1))
        const insertAt = Math.min(queue.length, studyIndex + 1 + gap)
        queue = [...queue.slice(0, insertAt), item, ...queue.slice(insertAt)]
        setStudyQueue(queue)
      }
    }

    if (studyIndex + 1 < queue.length) setStudyIndex(value => value + 1)
    else finishSession()
  }

  function exitStudy() {
    if (!confirmLeaveStudy()) return
    const destination = activeDeck ? 'edit' : 'library'
    setStudyQueue([]); setStudyIndex(0); setRevealed(false); setSessionAnswers([])
    setMode(destination)
  }

  function backToDeck() { setSessionAnswers([]); setMode('edit') }
  function backToLibrary() { setSessionAnswers([]); setActiveDeck(null); setMode('library') }

  function goHome() {
    if (!confirmDiscardChanges()) return
    if (!confirmLeaveStudy()) return
    resetDeckForm(); resetCardForm()
    setMode('library'); setActiveDeck(null); setStudyQueue([]); setRevealed(false); setSessionAnswers([])
  }

  function handleExport() {
    const backup = { version: 1, exportedAt: today(), decks }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bluelearn-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImportSuccess(null)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const result = validateBackup(parsed)
        if (!result.ok) { setImportError(result.error); setPendingImport(null); return }
        setImportError(null); setPendingImport(result.decks)
      } catch {
        setImportError('El archivo no contiene JSON válido.'); setPendingImport(null)
      }
    }
    reader.onerror = () => setImportError('No pudimos leer el archivo.')
    reader.readAsText(file)
  }

  function applyImport(strategy: ImportStrategy) {
    if (!pendingImport) return
    const incoming = pendingImport
    setDecks(current => withColors(strategy === 'replace' ? incoming : mergeDecks(current, incoming)))
    setPendingImport(null)
    setImportSuccess(strategy === 'replace' ? 'Tu biblioteca fue reemplazada con el archivo importado.' : 'El archivo se combinó con tu biblioteca actual.')
  }

  useEffect(() => {
    if (mode !== 'study') return
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      if (event.key === ' ' || event.key === 'Enter') {
        if (tag === 'BUTTON') return
        event.preventDefault()
        if (!revealed) setRevealed(true)
        return
      }
      if (!revealed) return
      const ratingIndex = ['1', '2', '3', '4'].indexOf(event.key)
      if (ratingIndex === -1) return
      event.preventDefault()
      rateCard(RATINGS[ratingIndex])
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, revealed, studyCard, studyDeck, studyIndex, studyQueue])

  return (
    <div className="app-shell">
      <div inert={deckModal || cardModal ? true : undefined} aria-hidden={deckModal || cardModal ? 'true' : undefined}>
      <header>
        <button className="brand" onClick={goHome}><span>◒</span> Bluelearn</button>
        <nav><button className={mode === 'library' ? 'active' : ''} onClick={goHome}>Biblioteca</button><button disabled={!totalDue} onClick={() => startStudy()}>Repasar <b>{totalDue}</b></button></nav>
        <div className="avatar">C</div>
      </header>

      {mode === 'library' && <main>
        <section className="hero-copy"><p className="eyebrow">TU BIBLIOTECA DE APRENDIZAJE</p><h1>Aprender, recordar,<br/><em>crecer.</em></h1><p>Convierte cualquier tema en conocimiento que permanece.</p></section>
        <section className="stats"><div><strong>{decks.length}</strong><span>Mazos</span></div><div><strong>{totalCards}</strong><span>Tarjetas</span></div><div className="due"><strong>{totalDue}</strong><span>Para hoy</span></div></section>

        <div className="backup-bar">
          <span>Copia de seguridad · {decks.length} mazos, {totalCards} tarjetas</span>
          <div>
            <button type="button" onClick={handleExport}>⇩ Exportar backup</button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>⇧ Importar backup</button>
            <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={handleImportFile} />
          </div>
        </div>
        {importError && <div className="import-banner error" role="alert"><span>⚠ {importError}</span><button type="button" className="ack" aria-label="Cerrar aviso" onClick={() => setImportError(null)}>✕</button></div>}
        {importSuccess && <div className="import-banner success" role="status"><span>✓ {importSuccess}</span><button type="button" className="ack" aria-label="Cerrar aviso" onClick={() => setImportSuccess(null)}>✕</button></div>}
        {pendingImport && <div className="import-banner confirm" role="alertdialog" aria-label="Confirmar importación">
          <span>Encontramos {pendingImport.length} mazos y {pendingImport.reduce((sum, item) => sum + item.cards.length, 0)} tarjetas en el archivo. ¿Qué quieres hacer?</span>
          <div className="import-confirm-actions">
            <button type="button" className="primary" onClick={() => applyImport('merge')}>Combinar</button>
            <button type="button" onClick={() => applyImport('replace')}>Reemplazar todo</button>
            <button type="button" onClick={() => setPendingImport(null)}>Cancelar</button>
          </div>
        </div>}

        <div className="section-title"><div><p className="eyebrow">COLECCIONES</p><h2>Tus mazos</h2></div><button className="primary" onClick={openCreateDeck}>＋ Nuevo mazo</button></div>
        <section className="deck-grid">
          {decks.map((item, index) => {
            const due = item.cards.filter(card => isDue(card.nextReview, now)).length
            return <div className="deck" key={item.id} style={{'--deck-color': item.color} as React.CSSProperties}>
              <div className="deck-top">
                <span className="deck-number">0{index + 1}</span>
                <div className="deck-actions">
                  <button type="button" aria-label={`Editar ${item.title}`} title="Editar mazo" onClick={() => openEditDeck(item)}>✎</button>
                  <button type="button" aria-label={`Eliminar ${item.title}`} title="Eliminar mazo" onClick={() => handleDeleteDeck(item)}>✕</button>
                </div>
              </div>
              <button type="button" className="deck-open" onClick={() => { setActiveDeck(item.id); setMode('edit') }}>
                <span className="category">{item.category}</span><h3>{item.title}</h3><p>{item.cards.length} tarjetas</p><span className="deck-footer">{due ? `${due} para hoy` : 'Al día'} <i>→</i></span>
              </button>
            </div>
          })}
        </section>
      </main>}

      {mode === 'edit' && deck && <main>
        <button className="back" onClick={goHome}>← Biblioteca</button>
        <section className="deck-heading" style={{'--deck-color': deck.color} as React.CSSProperties}>
          <div><p className="eyebrow">{deck.category}</p><h1>{deck.title}</h1><p>{deck.cards.length} tarjetas · {dueCards.length} pendientes</p></div>
          <div className="deck-heading-actions">
            <button type="button" className="ghost" onClick={() => openEditDeck(deck)}>✎ Editar mazo</button>
            <button type="button" className="ghost danger" onClick={() => handleDeleteDeck(deck)}>✕ Eliminar mazo</button>
            <button className="primary" disabled={!dueCards.length} onClick={() => startStudy(deck.id)}>Repasar ahora →</button>
          </div>
        </section>
        <section className="card-list">
          <div className="section-title"><div><p className="eyebrow">CONTENIDO</p><h2>Tarjetas</h2></div><button type="button" className="primary" onClick={openCreateCard}>＋ Añadir tarjeta</button></div>
          {deck.cards.length === 0 ? (
            <div className="empty-state">
              <span>✦</span>
              <h3>Este mazo está listo para su primera tarjeta</h3>
              <p>Añade una pregunta y su respuesta para empezar a repasar «{deck.title}».</p>
              <button type="button" className="primary" onClick={openCreateCard}>＋ Añadir tu primera tarjeta</button>
            </div>
          ) : deck.cards.map(card => <article className="mini-card" key={card.id}>{card.image && <img src={card.image} alt=""/>}<div><strong>{card.front}</strong><p>{card.back}</p></div><span>{dueLabel(card.nextReview)}</span><div className="mini-card-actions"><button type="button" aria-label={`Editar ${card.front}`} title="Editar tarjeta" onClick={() => openEditCard(card)}>✎</button><button type="button" aria-label={`Eliminar ${card.front}`} title="Eliminar tarjeta" onClick={() => handleDeleteCard(card)}>✕</button></div></article>)}
        </section>
      </main>}

      {mode === 'study' && studyCard && studyDeck && <main className="study">
        <button className="back" onClick={exitStudy}>← Salir del repaso</button>
        <>
          <div className="progress"><span>{studyIndex + 1} de {studyQueue.length}</span><i><b style={{width: `${((studyIndex + 1) / studyQueue.length) * 100}%`}}/></i></div>
          <button className={`flashcard ${revealed ? 'revealed' : ''}`} onClick={() => setRevealed(true)} aria-label={revealed ? 'Respuesta revelada' : 'Toca para revelar la respuesta'}>
            <span className="study-deck" style={{background: studyDeck.color}}>{studyDeck.title}</span>
            {studyCard.image && <img src={studyCard.image} alt=""/>}
            <p className="eyebrow">{revealed ? 'RESPUESTA' : 'PREGUNTA'}</p>
            <h2>{revealed ? studyCard.back : studyCard.front}</h2>
            {revealed && studyCard.description && <p>{studyCard.description}</p>}
            {!revealed && <small><b>TOCA</b> para ver la respuesta</small>}
          </button>
          {revealed && <div className="quick-rating"><p>¿Cómo te fue?</p><div>
            {RATINGS.map(rating => <button key={rating} className={rating} onClick={() => rateCard(rating)}>
              <span>{RATING_META[rating].icon}</span><strong>{RATING_META[rating].label}</strong><small>{formatDue(scheduleCard(studyCard, rating).dueInMs)}</small>
            </button>)}
          </div></div>}
        </>
      </main>}

      {mode === 'complete' && <main className="study">
        <div className="complete">
          <span>✓</span>
          <p className="eyebrow">SESIÓN COMPLETADA</p>
          <h1>Buen trabajo</h1>
          <p>Repasaste {sessionSummary.uniqueCards} tarjeta{sessionSummary.uniqueCards === 1 ? '' : 's'} · {sessionSummary.totalAnswers} respuesta{sessionSummary.totalAnswers === 1 ? '' : 's'} en total</p>

          <div className="rating-breakdown">
            {RATINGS.map(rating => <div key={rating} className={rating}>
              <span>{RATING_META[rating].icon}</span><strong>{sessionSummary.distribution[rating]}</strong><small>{RATING_META[rating].label}</small>
            </div>)}
          </div>

          {sessionSummary.reinforcement.length > 0 && <div className="reinforcement">
            <p className="eyebrow">PARA REFORZAR</p>
            <ul>{sessionSummary.reinforcement.slice(0, 6).map(item => <li key={item.cardId}>{item.front}</li>)}</ul>
            {sessionSummary.reinforcement.length > 6 && <small>y {sessionSummary.reinforcement.length - 6} más</small>}
          </div>}

          {sessionSummary.earliestNext !== null && <p className="next-review">
            Próximo repaso disponible: <b>{sessionSummary.earliestNext <= Date.now() ? 'Hoy' : formatDue(sessionSummary.earliestNext - Date.now())}</b>
          </p>}

          <div className="complete-actions">
            {activeDeck && <button className="primary" onClick={backToDeck}>Volver al mazo</button>}
            <button className="ghost" onClick={backToLibrary}>Ir a la biblioteca</button>
          </div>
        </div>
      </main>}
      </div>

      {deckModal && <ModalSheet labelledBy="deck-modal-title" onClose={requestCloseDeckModal}>
        <form className="card-maker" onSubmit={submitDeckForm} noValidate>
          <p className="eyebrow">{deckModal.type === 'edit' ? 'EDITAR MAZO' : 'NUEVO MAZO'}</p>
          <h2 id="deck-modal-title">{deckModal.type === 'edit' ? 'Actualiza este mazo' : 'Empieza un mazo nuevo'}</h2>
          <label>Nombre del mazo
            <input
              ref={deckTitleFieldRef}
              value={deckTitle}
              onChange={e => { setDeckTitle(e.target.value); if (deckFormError) setDeckFormError(null) }}
              placeholder="Ej. Vocabulario de francés"
              aria-required="true"
              aria-invalid={deckFormError ? 'true' : 'false'}
              aria-describedby={deckFormError ? 'deck-title-error' : undefined}
            />
            {deckFormError && <span className="field-error" id="deck-title-error" role="alert">{deckFormError}</span>}
          </label>
          <label>Categoría o temática
            <input value={deckCategory} onChange={e => setDeckCategory(e.target.value)} placeholder="Ej. Idiomas"/>
            <span className="field-help">Opcional — ayuda a organizar tus mazos por tema.</span>
          </label>
          <button className="primary wide">{deckModal.type === 'edit' ? 'Guardar cambios' : 'Crear mazo'}</button>
          <button type="button" className="wide-cancel" onClick={requestCloseDeckModal}>Cancelar</button>
        </form>
      </ModalSheet>}

      {cardModal && deck && <ModalSheet labelledBy="card-modal-title" onClose={requestCloseCardModal}>
        {cardSaved ? (
          <div className="form-success" role="status" aria-live="polite">
            <span className="success-icon">✓</span>
            <h2 id="card-modal-title">Tarjeta añadida</h2>
            <p>Se guardó en «{deck.title}».</p>
            <div className="saved-card"><strong>{front}</strong><p>{back}</p></div>
            <div className="success-actions">
              <button type="button" className="primary" ref={addAnotherRef} onClick={addAnotherCard}>＋ Añadir otra</button>
              {dueCards.length > 0 && <button type="button" className="ghost" onClick={studyAfterCardSaved}>Comenzar a estudiar →</button>}
            </div>
            <button type="button" className="wide-cancel" onClick={resetCardForm}>Listo, volver al mazo</button>
          </div>
        ) : (
          <form className="card-maker" onSubmit={submitCardForm} noValidate>
            <p className="eyebrow">{cardModal.type === 'edit' ? 'EDITAR TARJETA' : 'NUEVA TARJETA'}</p>
            <h2 id="card-modal-title">{cardModal.type === 'edit' ? 'Actualiza esta tarjeta' : 'Crea algo memorable'}</h2>
            <label>Pregunta o concepto
              <textarea
                ref={frontFieldRef}
                value={front}
                onChange={e => { setFront(e.target.value); if (cardFormErrors.front) setCardFormErrors(errs => ({ ...errs, front: undefined })) }}
                placeholder="¿Qué quieres recordar?"
                aria-required="true"
                aria-invalid={cardFormErrors.front ? 'true' : 'false'}
                aria-describedby={cardFormErrors.front ? 'card-front-error' : undefined}
              />
              {cardFormErrors.front && <span className="field-error" id="card-front-error" role="alert">{cardFormErrors.front}</span>}
            </label>
            <label>Respuesta
              <textarea
                value={back}
                onChange={e => { setBack(e.target.value); if (cardFormErrors.back) setCardFormErrors(errs => ({ ...errs, back: undefined })) }}
                placeholder="La respuesta esencial..."
                aria-required="true"
                aria-invalid={cardFormErrors.back ? 'true' : 'false'}
                aria-describedby={cardFormErrors.back ? 'card-back-error' : undefined}
              />
              {cardFormErrors.back && <span className="field-error" id="card-back-error" role="alert">{cardFormErrors.back}</span>}
            </label>
            <button className="enhance-toggle" type="button" onClick={() => setShowEnhancements(value => !value)}><span>✦</span><span><strong>Mejorar con IA e imagen</strong><small>Opcional</small></span><b>{showEnhancements ? '−' : '+'}</b></button>
            {showEnhancements && <div className="enhancements">
              <label>Descripción
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Añade contexto para entenderlo mejor"/>
                <span className="field-help">Opcional — se muestra junto a la respuesta al estudiar.</span>
              </label>
              <div className="assistant-row"><button type="button" onClick={writeDescription}>✦ Sugerir descripción</button><button type="button" onClick={findImages}>{loadingImages ? 'Buscando…' : '▧ Buscar imagen libre'}</button></div>
              {!!imageResults.length && <div className="image-strip">{imageResults.map(image => <button type="button" key={image.url} className={selectedImage === image.url ? 'selected' : ''} onClick={() => setSelectedImage(image.url)} title={image.title}><img src={image.url} alt={image.title}/></button>)}</div>}
            </div>}
            <button className="primary wide">{cardModal.type === 'edit' ? 'Guardar cambios' : 'Guardar tarjeta'}</button>
            <button type="button" className="wide-cancel" onClick={requestCloseCardModal}>Cancelar</button>
          </form>
        )}
      </ModalSheet>}
    </div>
  )
}

export default App
