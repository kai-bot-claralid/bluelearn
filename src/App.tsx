import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import './App.css'
import type { Card, Deck, Rating, SessionAnswer, StudyItem } from './study'
import { DAY, RATINGS, buildStudyQueue, computeProgress, computeSessionSummary, isDue, scheduleCard, scheduleRetry, today } from './study'
import { mergeDecks, parseStoredLibrary, validateBackup } from './backup'

type ImportStrategy = 'merge' | 'replace'
type DeckModal = { type: 'create' } | { type: 'edit'; deckId: string }
type CardModal = { type: 'create' } | { type: 'edit'; cardId: string }

const COLORS = ['#1769ff', '#ff6b5f', '#f4b942', '#24a47f', '#8b5cf6']
const RATING_META: Record<Rating, { label: string; icon: string }> = {
  again: { label: 'Otra vez', icon: '↺' },
  hard: { label: 'Difícil', icon: '−' },
  good: { label: 'Bien', icon: '✓' },
  easy: { label: 'Fácil', icon: '✦' },
}
const DUE_REFRESH_MS = 20_000
const DECKS_KEY = 'bluelearn-decks'

const starterDecks: Deck[] = [
  {
    id: 'biology', title: 'Biología celular', category: 'Ciencias', color: '#24a47f', isDemo: true,
    cards: [
      { id: 'mitochondria', front: '¿Cuál es la función de la mitocondria?', back: 'Producir ATP mediante la respiración celular.', description: 'Es el orgánulo que convierte la energía química de los nutrientes en energía utilizable por la célula.', image: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Mitochondria%2C_mammalian_lung_-_TEM.jpg', nextReview: new Date().toISOString(), interval: 0, ease: 2.5 },
      { id: 'membrane', front: '¿Qué modelo explica la membrana celular?', back: 'El modelo de mosaico fluido.', description: 'Describe una bicapa de fosfolípidos donde proteínas y otras moléculas pueden moverse lateralmente.', nextReview: new Date().toISOString(), interval: 0, ease: 2.5 },
    ],
  },
  { id: 'english', title: 'Inglés cotidiano', category: 'Idiomas', color: '#f4b942', isDemo: true, cards: [] },
  { id: 'design', title: 'Fundamentos de diseño', category: 'Creatividad', color: '#ff6b5f', isDemo: true, cards: [] },
]

function uid() { return crypto.randomUUID() }
function withColors(list: Deck[]): Deck[] { return list.map((item, index) => ({ ...item, color: COLORS[index % COLORS.length] })) }

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

type ActionMenuItem = { label: string; onSelect: () => void; danger?: boolean }

function ActionMenu({
  id, isOpen, onToggle, onClose, label, items, note, align = 'end', triggerContent, triggerClassName,
}: {
  id: string
  isOpen: boolean
  onToggle: () => void
  onClose: () => void
  label: string
  items: ActionMenuItem[]
  note?: string
  align?: 'start' | 'end'
  triggerContent?: ReactNode
  triggerClassName?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    function handlePointer(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointer)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [isOpen, onClose])

  useEffect(() => {
    if (isOpen) (listRef.current?.querySelector('[role="menuitem"]') as HTMLElement | null)?.focus()
  }, [isOpen])

  function handleListKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const menuItems = [...(listRef.current?.querySelectorAll('[role="menuitem"]') ?? [])] as HTMLElement[]
    if (!menuItems.length) return
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const nextIndex = (currentIndex + delta + menuItems.length) % menuItems.length
    menuItems[nextIndex]?.focus()
  }

  return (
    <div className="action-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`action-menu-trigger ${triggerClassName ?? ''}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? id : undefined}
        aria-label={label}
        onClick={event => { event.stopPropagation(); onToggle() }}
      >{triggerContent ?? '⋯'}</button>
      {isOpen && (
        <div
          className={`action-menu-list align-${align}`}
          id={id}
          role="menu"
          aria-label={label}
          ref={listRef}
          onMouseDown={event => event.stopPropagation()}
          onKeyDown={handleListKeyDown}
        >
          {note && <p className="action-menu-note">{note}</p>}
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'danger' : ''}
              onClick={event => { event.stopPropagation(); onClose(); item.onSelect() }}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

type RecoveryState = { raw: string; error: string }
type InitialLibraryState = { decks: Deck[]; needsOnboarding: boolean; recovery: RecoveryState | null }

function readInitialLibraryState(): InitialLibraryState {
  let saved: string | null
  try { saved = localStorage.getItem(DECKS_KEY) } catch { saved = null }
  const result = parseStoredLibrary(saved)
  if (result.status === 'empty') return { decks: [], needsOnboarding: true, recovery: null }
  if (result.status === 'corrupted') return { decks: [], needsOnboarding: false, recovery: { raw: saved as string, error: result.error } }
  return { decks: withColors(result.decks), needsOnboarding: false, recovery: null }
}

function App() {
  const [initialLibrary] = useState(readInitialLibraryState)
  const [decks, setDecks] = useState<Deck[]>(initialLibrary.decks)
  const [needsOnboarding, setNeedsOnboarding] = useState(initialLibrary.needsOnboarding)
  const [recovery, setRecovery] = useState<RecoveryState | null>(initialLibrary.recovery)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [activeDeck, setActiveDeck] = useState<string | null>(null)
  const [mode, setMode] = useState<'library' | 'edit' | 'study' | 'complete'>('library')
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  const [deckModal, setDeckModal] = useState<DeckModal | null>(null)
  const [deckTitle, setDeckTitle] = useState('')
  const [deckCategory, setDeckCategory] = useState('')
  const [deckFormError, setDeckFormError] = useState<string | null>(null)
  const deckFormInitial = useRef({ title: '', category: '' })
  const deckTitleFieldRef = useRef<HTMLInputElement>(null)
  const deckModalOpenerRef = useRef<HTMLElement | null>(null)
  const wasDeckModalOpen = useRef(false)

  const [cardModal, setCardModal] = useState<CardModal | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [description, setDescription] = useState('')
  const [selectedImage, setSelectedImage] = useState('')
  const [imageResults, setImageResults] = useState<{title: string, url: string}[]>([])
  const [loadingImages, setLoadingImages] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageSearchAttempted, setImageSearchAttempted] = useState(false)
  const [showEnhancements, setShowEnhancements] = useState(false)
  const [cardFormErrors, setCardFormErrors] = useState<{ front?: string; back?: string }>({})
  const [cardSaved, setCardSaved] = useState(false)
  const cardFormInitial = useRef({ front: '', back: '', description: '', image: '' })
  const frontFieldRef = useRef<HTMLTextAreaElement>(null)
  const addAnotherRef = useRef<HTMLButtonElement>(null)
  const cardModalOpenerRef = useRef<HTMLElement | null>(null)
  const wasCardModalOpen = useRef(false)

  const [revealed, setRevealed] = useState(false)
  const flashcardRef = useRef<HTMLButtonElement>(null)
  const [studyIndex, setStudyIndex] = useState(0)
  const [studyQueue, setStudyQueue] = useState<StudyItem[]>([])
  const [sessionAnswers, setSessionAnswers] = useState<SessionAnswer[]>([])
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<Deck[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const retryCounts = useRef<Map<string, number>>(new Map())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (needsOnboarding || recovery) return
    try {
      localStorage.setItem(DECKS_KEY, JSON.stringify(decks))
      setSaveError(null)
    } catch {
      setSaveError('No pudimos guardar tus últimos cambios en este dispositivo. Puede que el almacenamiento esté lleno o bloqueado; tus cambios solo existen en esta pestaña por ahora.')
    }
  }, [decks, needsOnboarding, recovery])

  useEffect(() => { setOpenMenu(null) }, [mode, activeDeck, deckModal, cardModal])

  function toggleMenu(id: string) { setOpenMenu(current => current === id ? null : id) }
  function closeMenu() { setOpenMenu(null) }

  function chooseOnboarding(choice: 'sample' | 'empty') {
    setDecks(choice === 'sample' ? starterDecks : [])
    setNeedsOnboarding(false)
  }

  function downloadRecoveryBackup() {
    if (!recovery) return
    const blob = new Blob([recovery.raw], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `bluelearn-recuperacion-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  function resetCorruptedLibrary() {
    if (!window.confirm('Esto borrará de forma permanente los datos guardados que no se pudieron leer. Ya descargaste (o decidiste no descargar) una copia. ¿Confirmas que quieres reiniciar la biblioteca?')) return
    try { localStorage.removeItem(DECKS_KEY) } catch {}
    setRecovery(null)
    setNeedsOnboarding(true)
  }

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
  const studyProgress = useMemo(() => computeProgress(studyQueue, studyIndex), [studyQueue, studyIndex])

  const isDeckFormDirty = deckModal !== null && (deckTitle.trim() !== deckFormInitial.current.title.trim() || deckCategory.trim() !== deckFormInitial.current.category.trim())
  const isCardFormDirty = cardModal !== null && !cardSaved && (
    front.trim() !== cardFormInitial.current.front.trim() ||
    back.trim() !== cardFormInitial.current.back.trim() ||
    description.trim() !== cardFormInitial.current.description.trim() ||
    selectedImage !== cardFormInitial.current.image
  )

  const sessionSummary = useMemo(() => computeSessionSummary(sessionAnswers), [sessionAnswers])

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

  useEffect(() => {
    if (wasDeckModalOpen.current && !deckModal) deckModalOpenerRef.current?.focus()
    wasDeckModalOpen.current = deckModal !== null
  }, [deckModal])
  useEffect(() => {
    if (wasCardModalOpen.current && !cardModal) cardModalOpenerRef.current?.focus()
    wasCardModalOpen.current = cardModal !== null
  }, [cardModal])

  useEffect(() => {
    if (mode === 'study' && !revealed) flashcardRef.current?.focus()
  }, [mode, studyIndex, revealed])

  function confirmDiscardChanges() {
    if (isDeckFormDirty && !window.confirm('Tienes cambios sin guardar en el mazo. ¿Quieres descartarlos?')) return false
    if (isCardFormDirty && !window.confirm('Tienes cambios sin guardar en la tarjeta. ¿Quieres descartarlos?')) return false
    return true
  }

  function openCreateDeck() {
    deckModalOpenerRef.current = document.activeElement as HTMLElement
    deckFormInitial.current = { title: '', category: '' }
    setDeckTitle(''); setDeckCategory(''); setDeckFormError(null)
    setDeckModal({ type: 'create' })
  }

  function openEditDeck(target: Deck) {
    deckModalOpenerRef.current = document.activeElement as HTMLElement
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
    cardModalOpenerRef.current = document.activeElement as HTMLElement
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false); setImageError(null); setImageSearchAttempted(false)
    setCardModal({ type: 'create' })
  }

  function openEditCard(card: Card) {
    cardModalOpenerRef.current = document.activeElement as HTMLElement
    cardFormInitial.current = { front: card.front, back: card.back, description: card.description, image: card.image ?? '' }
    setFront(card.front); setBack(card.back); setDescription(card.description); setSelectedImage(card.image ?? '')
    setImageResults([]); setShowEnhancements(!!(card.description || card.image))
    setCardFormErrors({}); setCardSaved(false); setImageError(null); setImageSearchAttempted(false)
    setCardModal({ type: 'edit', cardId: card.id })
  }

  function resetCardForm() {
    setCardModal(null)
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false); setImageError(null); setImageSearchAttempted(false)
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
  }

  function requestCloseCardModal() {
    if (isCardFormDirty && !window.confirm('Tienes cambios sin guardar en la tarjeta. ¿Quieres descartarlos?')) return
    resetCardForm()
  }

  function addAnotherCard() {
    cardFormInitial.current = { front: '', back: '', description: '', image: '' }
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
    setCardFormErrors({}); setCardSaved(false); setImageError(null); setImageSearchAttempted(false)
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
    setImageError(null)
    setImageSearchAttempted(true)
    try { setImageResults(await searchCommons(query)) }
    catch { setImageResults([]); setImageError('No pudimos buscar imágenes ahora mismo. Revisa tu conexión e inténtalo de nuevo.') }
    finally { setLoadingImages(false) }
  }

  function confirmLeaveStudy() {
    if (mode !== 'study') return true
    return window.confirm('¿Salir del repaso? Las tarjetas que ya calificaste quedan guardadas, pero perderás el resumen de esta sesión.')
  }

  function startStudy(deckId?: string, practiceAll = false) {
    if (!confirmDiscardChanges()) return
    if (!confirmLeaveStudy()) return
    const queue = buildStudyQueue(decks, deckId, practiceAll, Date.now())
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
      const retry = scheduleRetry(queue, studyIndex, item, attempts)
      if (retry.requeued) {
        retryCounts.current.set(card.id, attempts + 1)
        queue = retry.queue
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
    if (strategy === 'replace') {
      const incomingCards = incoming.reduce((sum, item) => sum + item.cards.length, 0)
      const confirmed = window.confirm(
        `Vas a reemplazar tu biblioteca actual (${decks.length} mazos, ${totalCards} tarjetas) por la del archivo (${incoming.length} mazos, ${incomingCards} tarjetas). Esta acción no se puede deshacer. ¿Confirmas el reemplazo?`
      )
      if (!confirmed) return
      setDecks(withColors(incoming))
      setPendingImport(null)
      setImportSuccess(`Tu biblioteca fue reemplazada con el archivo importado (${incoming.length} mazos, ${incomingCards} tarjetas).`)
      return
    }
    const { decks: mergedDecks, stats } = mergeDecks(decks, incoming)
    setDecks(withColors(mergedDecks))
    setPendingImport(null)
    const parts: string[] = []
    if (stats.addedDecks) parts.push(`${stats.addedDecks} mazo${stats.addedDecks === 1 ? '' : 's'} nuevo${stats.addedDecks === 1 ? '' : 's'}`)
    if (stats.addedCards) parts.push(`${stats.addedCards} tarjeta${stats.addedCards === 1 ? '' : 's'} nueva${stats.addedCards === 1 ? '' : 's'}`)
    if (stats.updatedCards) parts.push(`${stats.updatedCards} tarjeta${stats.updatedCards === 1 ? '' : 's'} actualizada${stats.updatedCards === 1 ? '' : 's'}`)
    setImportSuccess(parts.length ? `Combinado con tu biblioteca: ${parts.join(', ')}.` : 'El archivo se combinó con tu biblioteca actual (sin cambios nuevos).')
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

  if (recovery) {
    return (
      <div className="app-shell">
        <header><button className="brand" disabled><span>◒</span> Bluelearn</button></header>
        <main className="onboarding">
          <p className="eyebrow">RECUPERACIÓN</p>
          <h1>Algo no<br/><em>cuadra.</em></h1>
          <p>No pudimos leer la biblioteca guardada en este dispositivo: {recovery.error}</p>
          <p>Tus datos originales siguen intactos y no se han tocado. Descárgalos para revisarlos o guardarlos antes de decidir qué hacer.</p>
          <div className="onboarding-actions">
            <button type="button" className="primary" onClick={downloadRecoveryBackup}>⇩ Descargar copia</button>
            <button type="button" className="ghost danger-text" onClick={resetCorruptedLibrary}>Reiniciar biblioteca</button>
          </div>
        </main>
      </div>
    )
  }

  if (needsOnboarding) {
    return (
      <div className="app-shell">
        <header><button className="brand" disabled><span>◒</span> Bluelearn</button></header>
        <main className="onboarding">
          <p className="eyebrow">BIENVENIDO</p>
          <h1>Antes de<br/><em>empezar.</em></h1>
          <p>Puedes explorar Bluelearn con mazos de ejemplo o arrancar con una biblioteca vacía. Podrás cambiarlo cuando quieras.</p>
          <div className="onboarding-actions">
            <button type="button" className="primary" onClick={() => chooseOnboarding('sample')}>Explorar ejemplo</button>
            <button type="button" className="ghost" onClick={() => chooseOnboarding('empty')}>Comenzar desde cero</button>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div inert={deckModal || cardModal ? true : undefined} aria-hidden={deckModal || cardModal ? 'true' : undefined}>
      <header>
        <button className="brand" onClick={goHome}><span>◒</span> Bluelearn</button>
        <nav><button className={mode === 'library' ? 'active' : ''} onClick={goHome}>Biblioteca</button><button disabled={!totalDue} onClick={() => startStudy()}>Repasar <b>{totalDue}</b></button></nav>
      </header>

      {saveError && <div className="import-banner error save-error" role="alert">
        <span>⚠ {saveError}</span>
        <button type="button" className="ack" aria-label="Cerrar aviso" onClick={() => setSaveError(null)}>✕</button>
      </div>}

      {mode === 'library' && <main>
        <section className="hero-copy"><p className="eyebrow">TU BIBLIOTECA DE APRENDIZAJE</p><h1>Aprender, recordar,<br/><em>crecer.</em></h1><p>Convierte cualquier tema en conocimiento que permanece.</p></section>
        <section className="stats"><div><strong>{decks.length}</strong><span>Mazos</span></div><div><strong>{totalCards}</strong><span>Tarjetas</span></div><div className="due"><strong>{totalDue}</strong><span>Para hoy</span></div></section>

        <div className="library-options">
          <ActionMenu
            id="library-options-menu"
            isOpen={openMenu === 'library-options'}
            onToggle={() => toggleMenu('library-options')}
            onClose={closeMenu}
            label="Opciones de biblioteca"
            align="end"
            triggerClassName="text"
            triggerContent={<>⚙ Opciones de biblioteca</>}
            note={`${decks.length} mazos · ${totalCards} tarjetas`}
            items={[
              { label: '⇩ Exportar backup', onSelect: handleExport },
              { label: '⇧ Importar backup', onSelect: () => fileInputRef.current?.click() },
            ]}
          />
          <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={handleImportFile} />
        </div>
        {importError && <div className="import-banner error" role="alert"><span>⚠ {importError}</span><button type="button" className="ack" aria-label="Cerrar aviso" onClick={() => setImportError(null)}>✕</button></div>}
        {importSuccess && <div className="import-banner success" role="status"><span>✓ {importSuccess}</span><button type="button" className="ack" aria-label="Cerrar aviso" onClick={() => setImportSuccess(null)}>✕</button></div>}
        {pendingImport && <div className="import-banner confirm" role="alertdialog" aria-label="Confirmar importación">
          <span>Encontramos {pendingImport.length} mazos y {pendingImport.reduce((sum, item) => sum + item.cards.length, 0)} tarjetas en el archivo. ¿Qué quieres hacer?</span>
          <div className="import-confirm-actions">
            <button type="button" className="primary" onClick={() => applyImport('merge')}>Combinar</button>
            <button type="button" className="danger-text" onClick={() => applyImport('replace')}>Reemplazar todo</button>
            <button type="button" onClick={() => setPendingImport(null)}>Cancelar</button>
          </div>
        </div>}

        <div className="section-title"><div><p className="eyebrow">COLECCIONES</p><h2>Tus mazos</h2></div><button className="primary" onClick={openCreateDeck}>＋ Nuevo mazo</button></div>
        {decks.length === 0 ? (
          <div className="empty-state">
            <span>✦</span>
            <h3>Tu biblioteca está vacía</h3>
            <p>Crea tu primer mazo para empezar a guardar lo que quieres aprender.</p>
            <button type="button" className="primary" onClick={openCreateDeck}>＋ Nuevo mazo</button>
          </div>
        ) : <section className="deck-grid">
          {decks.map((item, index) => {
            const due = item.cards.filter(card => isDue(card.nextReview, now)).length
            const menuId = `deck-menu-${item.id}`
            return <div className="deck" key={item.id} style={{'--deck-color': item.color} as React.CSSProperties}>
              <div className="deck-top">
                <span className="deck-number">0{index + 1}</span>
                <ActionMenu
                  id={menuId}
                  isOpen={openMenu === menuId}
                  onToggle={() => toggleMenu(menuId)}
                  onClose={closeMenu}
                  label={`Más opciones para ${item.title}`}
                  items={[
                    { label: '✎ Editar mazo', onSelect: () => openEditDeck(item) },
                    { label: '✕ Eliminar mazo', onSelect: () => handleDeleteDeck(item), danger: true },
                  ]}
                />
              </div>
              <button type="button" className="deck-open" onClick={() => { setActiveDeck(item.id); setMode('edit') }}>
                <span className="category">{item.category}</span>{item.isDemo && <span className="demo-tag">Ejemplo</span>}<h3>{item.title}</h3><p>{item.cards.length} tarjetas</p><span className="deck-footer">{due ? `${due} para hoy` : 'Al día'} <i>→</i></span>
              </button>
            </div>
          })}
        </section>}
      </main>}

      {mode === 'edit' && deck && <main>
        <button className="back" onClick={goHome}>← Biblioteca</button>
        <section className="deck-heading" style={{'--deck-color': deck.color} as React.CSSProperties}>
          <div><p className="eyebrow">{deck.category}{deck.isDemo && <span className="demo-tag inline">Ejemplo</span>}</p><h1>{deck.title}</h1><p>{deck.cards.length} tarjetas · {dueCards.length} pendientes</p></div>
          <div className="deck-heading-actions">
            <ActionMenu
              id="deck-heading-menu"
              isOpen={openMenu === 'deck-heading-menu'}
              onToggle={() => toggleMenu('deck-heading-menu')}
              onClose={closeMenu}
              label={`Más opciones para ${deck.title}`}
              items={[
                { label: '✎ Editar mazo', onSelect: () => openEditDeck(deck) },
                { label: '✕ Eliminar mazo', onSelect: () => handleDeleteDeck(deck), danger: true },
              ]}
            />
            <button
              className="primary"
              disabled={!deck.cards.length}
              onClick={() => startStudy(deck.id, dueCards.length === 0)}
            >{dueCards.length ? 'Repasar ahora →' : 'Practicar mazo →'}</button>
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
          ) : deck.cards.map(card => {
            const menuId = `card-menu-${card.id}`
            return <article className="mini-card" key={card.id}>
              {card.image && <img src={card.image} alt=""/>}
              <div><strong>{card.front}</strong><p>{card.back}</p></div>
              <span>{dueLabel(card.nextReview)}</span>
              <ActionMenu
                id={menuId}
                isOpen={openMenu === menuId}
                onToggle={() => toggleMenu(menuId)}
                onClose={closeMenu}
                label={`Más opciones para ${card.front}`}
                items={[
                  { label: '✎ Editar tarjeta', onSelect: () => openEditCard(card) },
                  { label: '✕ Eliminar tarjeta', onSelect: () => handleDeleteCard(card), danger: true },
                ]}
              />
            </article>
          })}
        </section>
      </main>}

      {mode === 'study' && studyCard && studyDeck && <main className="study">
        <button className="back" onClick={exitStudy}>← Salir del repaso</button>
        <>
          <div className="progress">
            <span>
              {studyProgress.distinctSeen} de {studyProgress.totalCards}
              {studyProgress.repeats > 0 && <small> · +{studyProgress.repeats} repaso{studyProgress.repeats === 1 ? '' : 's'}</small>}
            </span>
            <i><b style={{width: `${(studyProgress.distinctSeen / studyProgress.totalCards) * 100}%`}}/></i>
          </div>
          <button ref={flashcardRef} className={`flashcard ${revealed ? 'revealed' : ''}`} onClick={() => setRevealed(true)} aria-label={revealed ? 'Respuesta revelada' : 'Toca para revelar la respuesta'}>
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
            <button className="enhance-toggle" type="button" onClick={() => setShowEnhancements(value => !value)}><span>✦</span><span><strong>Añadir contexto e imagen</strong><small>Opcional</small></span><b>{showEnhancements ? '−' : '+'}</b></button>
            {showEnhancements && <div className="enhancements">
              <label>Descripción
                <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Añade contexto para entenderlo mejor"/>
                <span className="field-help">Opcional — se muestra junto a la respuesta al estudiar.</span>
              </label>
              <div className="assistant-row"><button type="button" onClick={writeDescription}>✦ Sugerir descripción</button><button type="button" onClick={findImages}>{loadingImages ? 'Buscando…' : '▧ Buscar imagen libre'}</button></div>
              {imageError && <div className="image-search-error" role="alert"><span>⚠ {imageError}</span><button type="button" onClick={findImages}>Reintentar</button></div>}
              {!loadingImages && !imageError && imageSearchAttempted && imageResults.length === 0 && (
                <p className="image-search-empty" role="status">No encontramos imágenes libres para «{front || back}». Prueba con otras palabras.</p>
              )}
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
