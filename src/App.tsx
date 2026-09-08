import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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

const DAY = 86_400_000
const COLORS = ['#1769ff', '#ff6b5f', '#f4b942', '#24a47f', '#8b5cf6']

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

function App() {
  const [decks, setDecks] = useState<Deck[]>(() => {
    const saved = localStorage.getItem('bluelearn-decks')
    return saved ? JSON.parse(saved).map((item: Deck, index: number) => ({ ...item, color: COLORS[index % COLORS.length] })) : starterDecks
  })
  const [activeDeck, setActiveDeck] = useState<string | null>(null)
  const [mode, setMode] = useState<'library' | 'edit' | 'study'>('library')
  const [showDeckForm, setShowDeckForm] = useState(false)
  const [deckTitle, setDeckTitle] = useState('')
  const [deckCategory, setDeckCategory] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [description, setDescription] = useState('')
  const [selectedImage, setSelectedImage] = useState('')
  const [imageResults, setImageResults] = useState<{title: string, url: string}[]>([])
  const [loadingImages, setLoadingImages] = useState(false)
  const [showEnhancements, setShowEnhancements] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [studyIndex, setStudyIndex] = useState(0)
  const [studyQueue, setStudyQueue] = useState<StudyItem[]>([])

  useEffect(() => localStorage.setItem('bluelearn-decks', JSON.stringify(decks)), [decks])

  const deck = decks.find(item => item.id === activeDeck)
  const dueCards = useMemo(() => deck?.cards.filter(card => new Date(card.nextReview) <= new Date()) ?? [], [deck])
  const totalCards = decks.reduce((sum, item) => sum + item.cards.length, 0)
  const totalDue = decks.flatMap(item => item.cards).filter(card => new Date(card.nextReview) <= new Date()).length
  const studyItem = studyQueue[studyIndex]
  const studyDeck = decks.find(item => item.id === studyItem?.deckId)
  const studyCard = studyDeck?.cards.find(card => card.id === studyItem?.cardId)

  function createDeck(event: FormEvent) {
    event.preventDefault()
    if (!deckTitle.trim()) return
    const fresh: Deck = { id: uid(), title: deckTitle.trim(), category: deckCategory.trim() || 'General', color: COLORS[decks.length % COLORS.length], cards: [] }
    setDecks(current => [...current, fresh])
    setDeckTitle(''); setDeckCategory(''); setShowDeckForm(false); setActiveDeck(fresh.id); setMode('edit')
  }

  function createCard(event: FormEvent) {
    event.preventDefault()
    if (!deck || !front.trim() || !back.trim()) return
    const card: Card = { id: uid(), front: front.trim(), back: back.trim(), description: description.trim(), image: selectedImage || undefined, nextReview: today(), interval: 0, ease: 2.5 }
    setDecks(current => current.map(item => item.id === deck.id ? { ...item, cards: [...item.cards, card] } : item))
    setFront(''); setBack(''); setDescription(''); setSelectedImage(''); setImageResults([]); setShowEnhancements(false)
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

  function startStudy(deckId?: string) {
    const queue = decks.flatMap(item => item.cards
      .filter(card => (!deckId || item.id === deckId) && new Date(card.nextReview) <= new Date())
      .map(card => ({ deckId: item.id, cardId: card.id })))
    if (!queue.length) return
    if (!deckId) setActiveDeck(null)
    setStudyQueue(queue); setStudyIndex(0); setRevealed(false); setMode('study')
  }

  function rateCard(rating: 'hard' | 'easy') {
    const card = studyCard
    if (!studyDeck || !card) return
    const nextInterval = rating === 'hard' ? Math.max(1, card.interval * 1.2 || 1) : Math.max(4, card.interval * (card.ease + .35) || 4)
    const nextReview = new Date(Date.now() + nextInterval * DAY).toISOString()
    setDecks(current => current.map(item => item.id === studyDeck.id ? { ...item, cards: item.cards.map(candidate => candidate.id === card.id ? { ...candidate, interval: nextInterval, ease: Math.max(1.3, card.ease + (rating === 'hard' ? -.15 : .15)), nextReview } : candidate) } : item))
    setRevealed(false)
    if (studyIndex >= studyQueue.length - 1) { setStudyIndex(0); setStudyQueue([]); setMode(activeDeck ? 'edit' : 'library') } else setStudyIndex(value => value + 1)
  }

  function goHome() { setMode('library'); setActiveDeck(null); setStudyQueue([]); setRevealed(false) }

  return (
    <div className="app-shell">
      <header>
        <button className="brand" onClick={goHome}><span>◒</span> Bluelearn</button>
        <nav><button className={mode === 'library' ? 'active' : ''} onClick={goHome}>Biblioteca</button><button disabled={!totalDue} onClick={() => startStudy()}>Repasar <b>{totalDue}</b></button></nav>
        <div className="avatar">C</div>
      </header>

      {mode === 'library' && <main>
        <section className="hero-copy"><p className="eyebrow">TU BIBLIOTECA DE APRENDIZAJE</p><h1>Aprender, recordar,<br/><em>crecer.</em></h1><p>Convierte cualquier tema en conocimiento que permanece.</p></section>
        <section className="stats"><div><strong>{decks.length}</strong><span>Mazos</span></div><div><strong>{totalCards}</strong><span>Tarjetas</span></div><div className="due"><strong>{totalDue}</strong><span>Para hoy</span></div></section>
        <div className="section-title"><div><p className="eyebrow">COLECCIONES</p><h2>Tus mazos</h2></div><button className="primary" onClick={() => setShowDeckForm(true)}>＋ Nuevo mazo</button></div>
        {showDeckForm && <form className="deck-form" onSubmit={createDeck}><input autoFocus placeholder="Nombre del mazo" value={deckTitle} onChange={e => setDeckTitle(e.target.value)}/><input placeholder="Categoría o temática" value={deckCategory} onChange={e => setDeckCategory(e.target.value)}/><button className="primary">Crear</button><button type="button" onClick={() => setShowDeckForm(false)}>Cancelar</button></form>}
        <section className="deck-grid">
          {decks.map((item, index) => {
            const due = item.cards.filter(card => new Date(card.nextReview) <= new Date()).length
            return <button className="deck" key={item.id} onClick={() => { setActiveDeck(item.id); setMode('edit') }} style={{'--deck-color': item.color} as React.CSSProperties}>
              <span className="deck-number">0{index + 1}</span><span className="category">{item.category}</span><h3>{item.title}</h3><p>{item.cards.length} tarjetas</p><span className="deck-footer">{due ? `${due} para hoy` : 'Al día'} <i>→</i></span>
            </button>
          })}
        </section>
      </main>}

      {mode === 'edit' && deck && <main>
        <button className="back" onClick={goHome}>← Biblioteca</button>
        <section className="deck-heading" style={{'--deck-color': deck.color} as React.CSSProperties}><div><p className="eyebrow">{deck.category}</p><h1>{deck.title}</h1><p>{deck.cards.length} tarjetas · {dueCards.length} pendientes</p></div><button className="primary" disabled={!dueCards.length} onClick={() => startStudy(deck.id)}>Repasar ahora →</button></section>
        <div className="workspace">
          <form className="card-maker" onSubmit={createCard}>
            <p className="eyebrow">NUEVA TARJETA</p><h2>Crea algo memorable</h2>
            <label>Pregunta o concepto<textarea value={front} onChange={e => setFront(e.target.value)} placeholder="¿Qué quieres recordar?"/></label>
            <label>Respuesta<textarea value={back} onChange={e => setBack(e.target.value)} placeholder="La respuesta esencial..."/></label>
            <button className="enhance-toggle" type="button" onClick={() => setShowEnhancements(value => !value)}><span>✦</span><span><strong>Mejorar con IA e imagen</strong><small>Opcional</small></span><b>{showEnhancements ? '−' : '+'}</b></button>
            {showEnhancements && <div className="enhancements"><label>Descripción<textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Añade contexto para entenderlo mejor"/></label>
              <div className="assistant-row"><button type="button" onClick={writeDescription}>✦ Sugerir descripción</button><button type="button" onClick={findImages}>{loadingImages ? 'Buscando…' : '▧ Buscar imagen libre'}</button></div>
              {!!imageResults.length && <div className="image-strip">{imageResults.map(image => <button type="button" key={image.url} className={selectedImage === image.url ? 'selected' : ''} onClick={() => setSelectedImage(image.url)} title={image.title}><img src={image.url} alt={image.title}/></button>)}</div>}
            </div>}
            <button className="primary wide">Guardar tarjeta</button>
          </form>
          <section className="card-list"><div className="section-title"><div><p className="eyebrow">CONTENIDO</p><h2>Tarjetas</h2></div></div>
            {deck.cards.length === 0 ? <div className="empty">Tu primera tarjeta aparecerá aquí.</div> : deck.cards.map(card => <article className="mini-card" key={card.id}>{card.image && <img src={card.image} alt=""/>}<div><strong>{card.front}</strong><p>{card.back}</p></div><span>{new Date(card.nextReview) <= new Date() ? 'Hoy' : `${Math.ceil((new Date(card.nextReview).getTime() - Date.now()) / DAY)} d`}</span></article>)}
          </section>
        </div>
      </main>}

      {mode === 'study' && studyCard && studyDeck && <main className="study">
        <button className="back" onClick={() => setMode(activeDeck ? 'edit' : 'library')}>← Salir del repaso</button>
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
          {revealed && <div className="quick-rating"><p>¿Cómo te fue?</p><div><button className="hard" onClick={() => rateCard('hard')}><span>↺</span><strong>Difícil</strong><small>Ver antes</small></button><button className="easy" onClick={() => rateCard('easy')}><strong>Fácil</strong><span>→</span><small>Siguiente</small></button></div></div>}
        </>
      </main>}
    </div>
  )
}

export default App
