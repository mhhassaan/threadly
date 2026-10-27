import { Fragment, useEffect, useRef, useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { summarize } from '../lib/summary'
import { createThreadImage } from '../lib/export'
import { example } from '../lib/example'
import {
  assignMedia,
  cacheKey,
  libraryKey,
  loadLibrary,
  mediaUrl,
  normalizeRecord,
  remoteUrl,
  textMedia,
  validRecord,
} from '../lib/thread'
import type {
  Depth,
  Media,
  Mode,
  Reaction,
  Source,
  ThreadRecord,
} from '../lib/thread'
import '../lib/appearance'
import { Icon, Post, ThreadReplyComposer } from './Post'
import { AppearancePanel } from './AppearancePanel'
import { Dialog } from './Dialog'
import { ExportOptions } from './ExportOptions'
type Modal =
  | { kind: 'library' | 'appearance' | 'about' | 'export' | 'result' }
  | { kind: 'reply'; index: number }
  | { kind: 'media'; item: Media }
type ReaderWindow = {
  win: Window | null
  token: string
  data: ThreadRecord | null
  pointer: boolean
}
const libraryQuery = ['local-library'] as const
export function Threadly({
  readerToken,
  motion,
}: {
  readerToken?: string
  motion?: string
}) {
  const [selectionMode, setSelectionMode] = useState(false)
  const isReader = readerToken !== undefined
  const queryClient = useQueryClient()
  const [ready, setReady] = useState(false),
    [mode, setMode] = useState<Mode>('text'),
    [depth, setDepth] = useState<Depth>('balanced'),
    [length, setLength] = useState('auto'),
    [text, setText] = useState(''),
    [url, setUrl] = useState(''),
    [fileName, setFileName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [record, setRecord] = useState<ThreadRecord | null>(null),
    [selected, setSelected] = useState<Set<number>>(new Set()),
    [notice, setNotice] = useState<{
      blocked: boolean
      pointer: boolean
    } | null>(null),
    [toast, setToast] = useState(''),
    [modal, setModal] = useState<Modal | null>(null),
    [readerProblem, setReaderProblem] = useState(''),
    [drag, setDrag] = useState(false),
    [exportBusy, setExportBusy] = useState(false),
    [exportResult, setExportResult] = useState<{
      url: string
      filename: string
      png: boolean
    } | null>(null)
  const method = useRef('keyboard'),
    keyboardUsed = useRef(false),
    arrivalPlayed = useRef(false),
    arrival = useRef<Animation | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    readerWindows = useRef(new Map<string, ReaderWindow>()),
    latest = useRef<ThreadRecord | null>(null),
    recordRef = useRef<ThreadRecord | null>(null),
    exportUrl = useRef<string | null>(null),
    busyRef = useRef(false)
  const textRef = useRef<HTMLTextAreaElement>(null),
    urlRef = useRef<HTMLInputElement>(null),
    fileRef = useRef<HTMLInputElement>(null)
  const library = useQuery({
    queryKey: libraryQuery,
    queryFn: loadLibrary,
    enabled: ready,
  })
  const saved = library.data || []
  const notify = useCallback((message: string) => {
    setToast(message)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(''), 2800)
  }, [])
  const storeLibrary = useCallback(
    (items: ThreadRecord[]) => {
      try {
        localStorage.setItem(libraryKey, JSON.stringify(items))
        queryClient.setQueryData(libraryQuery, items)
        return true
      } catch {
        notify('Browser storage unavailable. Download your thread instead.')
        return false
      }
    },
    [queryClient, notify],
  )
  const accept = useCallback((data: ThreadRecord) => {
    if (!validRecord(data)) return
    const next = normalizeRecord(data)
    recordRef.current = next
    setRecord(next)
    setSelected(new Set())
    setReaderProblem('')
  }, [])
  useEffect(() => {
    setReady(true)
    document.documentElement.classList.toggle('reader-page', isReader)
    document.documentElement.dataset.motionInput = 'keyboard'
    const pointer = () => {
      method.current = 'pointer'
      document.documentElement.dataset.motionInput = 'pointer'
    }
    const keyboard = () => {
      method.current = 'keyboard'
      keyboardUsed.current = true
      arrival.current?.cancel()
      document.documentElement.dataset.motionInput = 'keyboard'
    }
    const storage = (e: StorageEvent) => {
      if (e.key === libraryKey)
        void queryClient.invalidateQueries({ queryKey: libraryQuery })
    }
    const message = (event: MessageEvent) => {
      if (event.origin !== location.origin || !event.data) return
      const data = event.data
      if (isReader && data.type === 'threadly:result') {
        if (
          event.source === window.opener &&
          data.token === readerToken &&
          validRecord(data.record)
        )
          accept(data.record)
        return
      }
      if (data.type === 'threadly:ready') {
        const entry = readerWindows.current.get(data.token)
        if (entry && entry.win === event.source && entry.data)
          entry.win?.postMessage(
            { type: 'threadly:result', token: entry.token, record: entry.data },
            location.origin,
          )
      }
    }
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('keydown', keyboard, true)
    window.addEventListener('storage', storage)
    window.addEventListener('message', message)
    if (isReader) {
      let cached
      try {
        cached = JSON.parse(
          sessionStorage.getItem(cacheKey(readerToken!)) || 'null',
        )
      } catch {}
      if (validRecord(cached)) accept(cached)
      else if (window.opener)
        window.opener.postMessage(
          { type: 'threadly:ready', token: readerToken },
          location.origin,
        )
      else
        setReaderProblem(
          'This reading window could not recover your thread. Create a new one from your source.',
        )
    }
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      document.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('storage', storage)
      window.removeEventListener('message', message)
      arrival.current?.cancel()
      if (timer.current) clearTimeout(timer.current)
      if (exportUrl.current) URL.revokeObjectURL(exportUrl.current)
    }
  }, [isReader, readerToken, queryClient, accept])
  useEffect(() => {
    if (record) {
      recordRef.current = record
      document.title = record.title + ' — Threadly'
      if (readerToken)
        try {
          sessionStorage.setItem(cacheKey(readerToken), JSON.stringify(record))
        } catch {}
    }
  }, [record, readerToken])
  useEffect(() => {
    if (!ready || (isReader && !record) || arrivalPlayed.current) return
    arrivalPlayed.current = true
    const direction = isReader ? 'forward' : 'back'
    if (
      keyboardUsed.current ||
      motion !== direction ||
      (
        performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined
      )?.type !== 'navigate'
    )
      return
    const target = document.querySelector(
      isReader ? '.reading-window' : '.dashboard',
    )
    if (!(target instanceof HTMLElement)) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    arrival.current = target.animate(
      [
        {
          opacity: 0,
          ...(!reduced
            ? { transform: `translateY(${isReader ? 8 : -8}px)` }
            : {}),
        },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: reduced ? 120 : 220,
        easing: getComputedStyle(document.documentElement)
          .getPropertyValue('--ease-out')
          .trim(),
      },
    )
  }, [ready, record, isReader, motion])
  const article = useMutation({
    mutationFn: async (articleUrl: string) => {
      const response = await fetch('/api/article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: articleUrl }),
      })
      const data: unknown = await response.json()
      if (!response.ok) {
        const message =
          data &&
          typeof data === 'object' &&
          'error' in data &&
          typeof data.error === 'string' &&
          data.error
            ? data.error
            : 'Could not read this article.'
        throw Error(message)
      }
      return data as {
        text: string
        title: string
        url: string
        source: Source
        media: Media[]
      }
    },
  })
  function launch(data: ThreadRecord | null = null) {
    const token = crypto.randomUUID(),
      destination = new URL('/', location.href)
    destination.searchParams.set('reader', token)
    destination.searchParams.set(
      'motion',
      method.current === 'pointer' ? 'forward' : 'none',
    )
    const win = window.open(destination.href, '_blank')
    const entry = { win, token, data, pointer: method.current === 'pointer' }
    readerWindows.current.set(token, entry)
    return entry
  }
  function openRecord(data: ThreadRecord) {
    latest.current = data
    const entry = launch(data)
    setModal(null)
    if (isReader && !entry.win) accept(data)
    else setNotice({ blocked: !entry.win, pointer: entry.pointer })
  }
  async function generate() {
    if (busyRef.current) return
    setError('')
    if (mode === 'url' && !remoteUrl(url)) {
      setError('Add a valid article link, starting with https://.')
      urlRef.current?.focus()
      return
    }
    if (
      mode !== 'url' &&
      text.trim().split(/\s+/).filter(Boolean).length < 30
    ) {
      setError('Add at least 30 words for a thread with enough context.')
      ;(mode === 'file'
        ? document.getElementById('chooseFile')
        : textRef.current
      )?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setNotice(null)
    const entry = launch()
    try {
      let sourceText = text.trim(),
        title = sourceText.split('\n')[0].slice(0, 100),
        sourceUrl = '',
        source: Source | null = null,
        media = textMedia(sourceText)
      const attributed = sourceText.match(/^Source:\s*(https?:\/\/\S+)/im)
      if (attributed && remoteUrl(attributed[1])) {
        const u = new URL(attributed[1])
        sourceUrl = u.href
        source = {
          name: u.hostname.replace(/^www\./, ''),
          handle: u.hostname.replace(/^www\./, ''),
          url: u.origin,
          icon: new URL('/favicon.ico', u).href,
        }
      }
      if (mode === 'url') {
        const data = await article.mutateAsync(url)
        sourceText = data.text
        title = data.title
        sourceUrl = data.url
        source = data.source
        media = data.media || []
      }
      if (sourceText.split(/\s+/).filter(Boolean).length < 30)
        throw Error(
          'We could not find enough article text. Paste the source text instead.',
        )
      const posts = summarize(
        sourceText.replace(/!\[[^\]]*\]\([^)]+\)/g, ''),
        depth,
        length,
      )
      const next: ThreadRecord = {
        id: crypto.randomUUID(),
        title: title || 'Your reading thread',
        posts,
        sourceUrl,
        source,
        media: assignMedia(media, posts, sourceText),
        interactions: {},
        sourceText,
      }
      latest.current = next
      entry.data = next
      if (entry.win && !entry.win.closed)
        entry.win.postMessage(
          { type: 'threadly:result', token: entry.token, record: next },
          location.origin,
        )
      setNotice({
        blocked: !entry.win || entry.win.closed,
        pointer: entry.pointer,
      })
      notify('Your thread is ready')
    } catch (e) {
      entry.win?.close()
      setError(
        e instanceof Error
          ? e.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  function switchMode(next: Mode) {
    setMode(next)
    setError('')
  }
  async function loadFile(file?: File) {
    if (!file) return
    setError('')
    if (file.size > 1_000_000) {
      setError('Choose a file smaller than 1 MB.')
      return
    }
    if (!/\.(txt|md)$/i.test(file.name)) {
      setError('Choose a text (.txt) or Markdown (.md) file.')
      return
    }
    try {
      const data = await file.text()
      if (data.length > 100000)
        throw Error('Use a file containing up to 100,000 characters.')
      setText(data)
      setFileName(file.name)
      switchMode('text')
      notify('File loaded. Your text is ready to turn into a thread.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read file.')
    }
  }
  function updateRecord(next: ThreadRecord, ensureSaved = false) {
    recordRef.current = next
    setRecord(next)
    const items = loadLibrary(),
      index = items.findIndex((item) => item.id === next.id)
    if (index >= 0) {
      items[index] = next
      storeLibrary(items)
    } else if (ensureSaved) storeLibrary([next, ...items])
  }
  function save() {
    if (!record) return
    const items = loadLibrary()
    if (items.some((item) => item.posts.join('') === record.posts.join(''))) {
      notify('Already in your saved threads')
      return
    }
    if (
      storeLibrary([
        { ...record, date: new Date().toLocaleDateString() },
        ...items,
      ])
    )
      notify('Saved on this device')
  }
  function react(index: number, key: 'liked' | 'reposted' | 'bookmarked') {
    if (!record) return
    const old = record.interactions[index] || { replies: [] }
    const state = { ...old, [key]: !old[key] }
    updateRecord(
      { ...record, interactions: { ...record.interactions, [index]: state } },
      key === 'bookmarked' && !!state.bookmarked,
    )
    if (key === 'reposted')
      notify(
        state.reposted
          ? 'Reposted in this thread · only you can see this'
          : 'Local repost removed',
      )
    if (key === 'bookmarked')
      notify(
        state.bookmarked
          ? 'Tweet bookmarked · thread saved on this device'
          : 'Tweet bookmark removed',
      )
  }
  function toggleSelection(index: number) {
    setSelected((old) => {
      const next = new Set(old)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const numbered = (index: number) =>
    record
      ? record.posts[index] + ' ' + (index + 1) + '/' + record.posts.length
      : ''
  const fullText = () =>
    record
      ? record.title +
        '\n\n' +
        record.posts.map((_, i) => numbered(i)).join('\n\n') +
        (record.sourceUrl ? '\n\nSource: ' + record.sourceUrl : '')
      : ''
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      notify('Copied to clipboard')
    } catch {
      notify('Clipboard unavailable. Download your thread instead.')
    }
  }
  function download(blob: Blob, filename: string) {
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }
  async function share(index: number) {
    try {
      if (navigator.share)
        await navigator.share({ title: 'Threadly', text: numbered(index) })
      else await copy(numbered(index))
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'AbortError')
        notify('Sharing unavailable. Try copying this tweet.')
    }
  }
  async function exportImages(indices: number[]) {
    if (!record || !indices.length || exportBusy) return
    setExportBusy(true)
    try {
      const result = await createThreadImage({
        ...record,
        indices,
        theme: window.ThreadlyAppearance.colors(),
      })
      if (exportUrl.current) URL.revokeObjectURL(exportUrl.current)
      const objectUrl = URL.createObjectURL(result.blob)
      exportUrl.current = objectUrl
      setExportResult({
        url: objectUrl,
        filename: result.filename,
        png: result.blob.type === 'image/png',
      })
      if (!modal) setModal({ kind: 'result' })
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = result.filename
      a.click()
      notify(
        result.warnings
          ? 'Image downloaded · some source images were unavailable'
          : result.filename.endsWith('.zip')
            ? 'Image pages downloaded as a ZIP'
            : 'Image downloaded',
      )
    } catch (e) {
      notify(
        e instanceof Error
          ? e.message
          : 'Could not create the image. Try fewer tweets.',
      )
    } finally {
      setExportBusy(false)
    }
  }
  const backHref =
    '/?motion=' + (method.current === 'pointer' ? 'back' : 'none')
  function returnIntent(e: React.MouseEvent<HTMLAnchorElement>) {
    if (isReader)
      e.currentTarget.href =
        '/?motion=' + (method.current === 'pointer' ? 'back' : 'none')
  }
  const modalTitle =
    modal?.kind === 'library'
      ? 'Your saved threads'
      : modal?.kind === 'appearance'
        ? 'Make yourself comfortable'
        : modal?.kind === 'about'
          ? 'A little less reading. A lot more clarity.'
          : modal?.kind === 'export'
            ? 'Save your thread as an image'
            : modal?.kind === 'reply'
              ? 'Your replies to tweet ' + (modal.index + 1)
              : modal?.kind === 'media'
                ? 'Image from the article'
                : 'Your image is ready'
  return (
    <>
      <header className="app-header">
        <a
          className="brand"
          href="/"
          aria-label="Threadly home"
          onClick={returnIntent}
        >
          <img
            className="brand-symbol"
            src="/brand/threadly-mark.svg"
            width="36"
            height="36"
            alt=""
          />
          <span className="brand-wordmark">threadly</span>
          <small>BETA</small>
        </a>
        <nav aria-label="Main navigation">
          <a
            id="newThread"
            className={!isReader ? 'nav-active' : ''}
            href="/"
            onClick={(e) => {
              if (!isReader) {
                e.preventDefault()
                textRef.current?.focus()
              } else returnIntent(e)
            }}
          >
            Create a thread
          </a>
          <button id="library" onClick={() => setModal({ kind: 'library' })}>
            Saved threads <span id="savedCount">{saved.length}</span>
          </button>
        </nav>
        <div className="header-tools">
          <button
            id="appearance"
            className="appearance-button"
            aria-label="Appearance and themes"
            onClick={() => setModal({ kind: 'appearance' })}
          >
            ◐ <span>Appearance</span>
          </button>
          <button
            className="about-button"
            id="about"
            onClick={() => setModal({ kind: 'about' })}
          >
            How it works <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>
      {!isReader ? (
        <main className="dashboard">
          <section className="intro-block" aria-labelledby="dashboardTitle">
            <p className="eyebrow">
              <span aria-hidden="true" /> A LITTLE LESS OVERWHELM
            </p>
            <h1 id="dashboardTitle">
              A big idea.
              <br />A little easier to read<span>.</span>
            </h1>
            <p className="intro">
              Bring an article. Keep the context.
              <br />
              We’ll turn it into a thread, in a space made for reading.
            </p>
          </section>
          <section className="source panel" aria-labelledby="sourceHeading">
            <div className="panel-title">
              <div>
                <span className="step" aria-hidden="true">
                  01
                </span>
                <h2 id="sourceHeading">Start with your source</h2>
              </div>
              <span className="private-label">Just for you</span>
            </div>
            <div className="tabs" role="tablist" aria-label="Source type">
              {(['text', 'url', 'file'] as Mode[]).map((key, i) => (
                <button
                  key={key}
                  id={key + 'Tab'}
                  role="tab"
                  aria-selected={mode === key}
                  aria-controls={key + 'Pane'}
                  tabIndex={mode === key ? 0 : -1}
                  className={mode === key ? 'selected' : ''}
                  onClick={() => switchMode(key)}
                  onKeyDown={(e) => {
                    const keys: Mode[] = ['text', 'url', 'file']
                    let n = i
                    if (e.key === 'ArrowRight') n = (i + 1) % 3
                    else if (e.key === 'ArrowLeft') n = (i + 2) % 3
                    else if (e.key === 'Home') n = 0
                    else if (e.key === 'End') n = 2
                    else return
                    e.preventDefault()
                    switchMode(keys[n])
                    document.getElementById(keys[n] + 'Tab')?.focus()
                  }}
                >
                  {['≡', '↗', '⇧'][i]}{' '}
                  <span>
                    {['Paste text', 'Article link', 'Upload file'][i]}
                  </span>
                </button>
              ))}
            </div>
            <div className="source-panes">
              <div
                id="textPane"
                role="tabpanel"
                aria-labelledby="textTab"
                hidden={mode !== 'text'}
              >
                <label className="sr-only" htmlFor="sourceText">
                  Source text
                </label>
                <div className="source-input text-input">
                  <textarea
                    ref={textRef}
                    id="sourceText"
                    maxLength={100000}
                    placeholder="Paste the article, essay, or idea you’ve been meaning to read…"
                    aria-describedby="sourceHint wordCount"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault()
                        void generate()
                      }
                    }}
                  />
                  <div className="text-footer">
                    <span id="wordCount">
                      {text
                        .trim()
                        .split(/\s+/)
                        .filter(Boolean)
                        .length.toLocaleString()}{' '}
                      words
                    </span>
                    <button
                      id="clear"
                      onClick={() => {
                        setText('')
                        textRef.current?.focus()
                      }}
                    >
                      Clear text
                    </button>
                  </div>
                </div>
                <p className="hint" id="sourceHint">
                  Start with at least 30 words so we can keep the context.
                </p>
              </div>
              <div
                id="urlPane"
                role="tabpanel"
                aria-labelledby="urlTab"
                hidden={mode !== 'url'}
              >
                <div className="source-input link-input">
                  <label className="field-label" htmlFor="articleUrl">
                    Article URL
                  </label>
                  <input
                    ref={urlRef}
                    type="url"
                    id="articleUrl"
                    placeholder="https://example.com/something-worth-reading"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    enterKeyHint="go"
                    aria-describedby="urlHint"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void generate()
                      }
                    }}
                  />
                </div>
                <p className="hint" id="urlHint">
                  Public articles work best. For paywalled pages, paste the
                  text.
                </p>
              </div>
              <div
                id="filePane"
                role="tabpanel"
                aria-labelledby="fileTab"
                hidden={mode !== 'file'}
              >
                <div
                  id="dropZone"
                  className={
                    'source-input drop-zone' + (drag ? ' drag-over' : '')
                  }
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDrag(true)
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDrag(false)
                    void loadFile(e.dataTransfer.files[0])
                  }}
                >
                  <div className="upload-heading">
                    <span className="upload-icon" aria-hidden="true">
                      ⇧
                    </span>
                    <strong>A good read starts here</strong>
                  </div>
                  <p>Drop a text file here, or choose one.</p>
                  <button
                    id="chooseFile"
                    className="secondary"
                    onClick={() => fileRef.current?.click()}
                  >
                    Browse files
                  </button>
                  <small>TXT or Markdown · up to 1 MB</small>
                  <input
                    ref={fileRef}
                    id="fileInput"
                    type="file"
                    accept=".txt,.md,text/plain,text/markdown"
                    className="sr-only"
                    tabIndex={-1}
                    aria-label="Upload a text or Markdown file"
                    onChange={(e) => {
                      void loadFile(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </div>
                <p id="fileName" className="hint" role="status">
                  {fileName ||
                    'Your text opens in the editor, ready to review.'}
                </p>
              </div>
            </div>
            <fieldset className="settings">
              <legend>How much detail feels right?</legend>
              <div className="depth" role="group" aria-label="Summary depth">
                {(['quick', 'balanced', 'detailed'] as Depth[]).map((d, i) => (
                  <button
                    key={d}
                    data-depth={d}
                    aria-pressed={depth === d}
                    className={depth === d ? 'active' : ''}
                    onClick={() => setDepth(d)}
                  >
                    <strong>
                      {['Quick read', 'Balanced', 'Deep dive'][i]}
                      {i === 1 && <span aria-hidden="true"> ✦</span>}
                    </strong>
                    <span>
                      {
                        [
                          'The essentials',
                          'Clarity + context',
                          'Room for nuance',
                        ][i]
                      }
                    </span>
                  </button>
                ))}
              </div>
              <div className="length">
                <label htmlFor="length">Thread length</label>
                <select
                  id="length"
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                >
                  <option value="auto">Auto · recommended</option>
                  <option value="5">Up to 5 posts</option>
                  <option value="10">Up to 10 posts</option>
                  <option value="20">Up to 20 posts</option>
                </select>
              </div>
            </fieldset>
            <div id="error" role="alert" hidden={!error}>
              {error}
            </div>
            <button
              id="generate"
              className="generate"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void generate()}
            >
              <span>
                {busy
                  ? mode === 'url'
                    ? 'Reading your article…'
                    : 'Creating your thread…'
                  : 'Create my thread'}
              </span>
            </button>
            {notice && (
              <div
                id="resultNotice"
                className="result-notice"
                data-motion-input={notice.pointer ? 'pointer' : 'keyboard'}
              >
                <div>
                  <strong>Your thread is ready</strong>
                  <p id="resultHint">
                    {notice.blocked
                      ? 'Your browser blocked the new window. Select Open thread to try again.'
                      : 'Your source stays here for your next read.'}
                  </p>
                </div>
                <button
                  id="reopenReader"
                  className="secondary"
                  onClick={() => {
                    if (latest.current) openRecord(latest.current)
                  }}
                >
                  Open thread ↗
                </button>
              </div>
            )}
            <div className="try">
              <span>Something to get you started?</span>
              <button
                id="example"
                className="text-button"
                onClick={() => {
                  setText(example)
                  switchMode('text')
                  requestAnimationFrame(() => textRef.current?.focus())
                  notify(
                    'Example added. Choose your depth, then create a thread.',
                  )
                }}
              >
                Try an example <span aria-hidden="true">↗</span>
              </button>
            </div>
          </section>
          <footer>
            <span className="footer-signature">
              <img
                src="/brand/threadly-mark.svg"
                width="22"
                height="22"
                alt=""
              />
              Built for curious minds.
            </span>
            <span>Read less noise. Keep more meaning.</span>
          </footer>
        </main>
      ) : (
        <main className="reading-window" aria-labelledby="readerTitle">
          <div className={record ? 'reader-intro sr-only' : 'reader-intro'}>
            <p className="eyebrow">YOUR SPACE TO READ</p>
            <h1 id="readerTitle">
              {record?.title ||
                (readerProblem
                  ? 'Your reading space'
                  : 'Getting your thread ready…')}
            </h1>
            <p id="readerDescription">
              {record
                ? 'The ideas that matter, with room for context.'
                : 'Your source is still open in the original window.'}
            </p>
            {remoteUrl(record?.sourceUrl) && (
              <a
                id="sourceLink"
                href={remoteUrl(record?.sourceUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read original article ↗
              </a>
            )}
          </div>
          <section
            className="reader panel"
            aria-label="Twitter-style reading thread"
          >
            <div className="reader-toolbar">
              <a
                className="thread-back"
                href={backHref}
                onClick={returnIntent}
                aria-label="Back to create a thread"
              >
                <Icon name="back" />
              </a>
              <div className="thread-heading">
                <h2>Post</h2>
                <span id="threadInfo" role="status">
                  {record
                    ? `${record.posts.length} tweets · ${Math.max(1, Math.ceil(record.posts.join(' ').split(/\s+/).length / 220))} min read`
                    : 'Preparing your thread'}
                </span>
              </div>
              {record && (
                <details
                  className="reader-options"
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('button'))
                      event.currentTarget.open = false
                  }}
                >
                  <summary aria-label="Thread options">
                    <Icon name="more" />
                  </summary>
                  <div className="reader-tools" id="readerTools">
                    <button id="save" className="secondary" onClick={save}>
                      Save
                    </button>
                    <button
                      id="download"
                      className="secondary"
                      onClick={() => {
                        download(
                          new Blob([fullText()], {
                            type: 'text/plain;charset=utf-8',
                          }),
                          'threadly-thread.txt',
                        )
                        notify('Thread downloaded')
                      }}
                    >
                      Text
                    </button>
                    <button
                      id="images"
                      className="secondary"
                      onClick={() => {
                        setExportResult(null)
                        setModal({ kind: 'export' })
                      }}
                    >
                      Save image
                    </button>
                    <button
                      id="copyAll"
                      className="copy-primary"
                      onClick={() => void copy(fullText())}
                    >
                      Copy thread
                    </button>
                    <button
                      className="secondary"
                      aria-pressed={selectionMode}
                      onClick={() => {
                        setSelectionMode(!selectionMode)
                        if (selectionMode) setSelected(new Set())
                      }}
                    >
                      {selectionMode ? 'Done selecting' : 'Select posts'}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setModal({ kind: 'appearance' })}
                    >
                      Appearance
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setModal({ kind: 'library' })}
                    >
                      Saved threads
                    </button>
                  </div>
                </details>
              )}
            </div>
            {record ? (
              <>
                <div
                  id="selectionBar"
                  className="selection-bar"
                  hidden={!selectionMode}
                >
                  <span id="selectionCount">
                    {selected.size
                      ? selected.size + ' selected'
                      : 'Select tweets for images'}
                  </span>
                  <button
                    id="selectAll"
                    className="text-button"
                    onClick={() =>
                      setSelected(new Set(record.posts.map((_, i) => i)))
                    }
                  >
                    Select all
                  </button>
                  <button
                    id="clearSelection"
                    className="text-button"
                    onClick={() => setSelected(new Set())}
                  >
                    Clear
                  </button>
                  <button
                    id="exportSelected"
                    className="secondary"
                    disabled={!selected.size || exportBusy}
                    onClick={() =>
                      void exportImages([...selected].sort((a, b) => a - b))
                    }
                  >
                    {exportBusy ? 'Creating image…' : 'Save selected'}
                  </button>
                </div>
                <div id="thread" className="thread">
                  {record.posts.map((_, i) => (
                    <Fragment key={record.id + ':' + i}>
                      <Post
                        selectionMode={selectionMode}
                        record={record}
                        index={i}
                        selected={selected.has(i)}
                        onSelect={toggleSelection}
                        onEdit={(index, value) => {
                          if (value === record.posts[index]) return
                          const posts = [...record.posts]
                          posts[index] = value
                          updateRecord({ ...record, posts })
                        }}
                        onReact={react}
                        onReply={(index) => {
                          if (index === 0)
                            document.getElementById('threadReply')?.focus()
                          else setModal({ kind: 'reply', index })
                        }}
                        onCopy={(i) => void copy(numbered(i))}
                        onShare={(i) => void share(i)}
                        onExport={(i) => void exportImages([i])}
                        onImage={(item) => setModal({ kind: 'media', item })}
                      />
                      {i === 0 && (
                        <>
                          <ThreadReplyComposer
                            onReply={(value) => {
                              const state: Reaction = record
                                .interactions[0] || { replies: [] }
                              updateRecord(
                                {
                                  ...record,
                                  interactions: {
                                    ...record.interactions,
                                    0: {
                                      ...state,
                                      replies: [
                                        ...(state.replies || []),
                                        {
                                          text: value,
                                          date: new Date().toISOString(),
                                        },
                                      ],
                                    },
                                  },
                                },
                                true,
                              )
                              notify('Reply saved on this device')
                            }}
                          />
                          {!!record.interactions[0]?.replies?.length && (
                            <div
                              className="thread-local-replies"
                              aria-label="Your local replies"
                            >
                              {record.interactions[0].replies.map(
                                (reply, index) => (
                                  <article key={index}>
                                    <div className="avatar">
                                      <Icon name="user" />
                                    </div>
                                    <div>
                                      <strong>
                                        You <span>@you · local</span>
                                      </strong>
                                      <p>{reply.text}</p>
                                    </div>
                                  </article>
                                ),
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </Fragment>
                  ))}
                </div>
                <div id="readerFoot" className="reader-bottom">
                  End of thread · {record.posts.length} posts
                </div>
              </>
            ) : (
              <div id="readerState" className="reader-state" role="status">
                <span className="loading-mark" aria-hidden="true">
                  ≋
                </span>
                <h2>
                  {readerProblem
                    ? 'No thread here yet'
                    : 'A little clarity is on its way'}
                </h2>
                <p>
                  {readerProblem || 'We’re collecting the ideas that matter.'}
                </p>
                {readerProblem && (
                  <a className="secondary" href="/" onClick={returnIntent}>
                    Create a thread
                  </a>
                )}
              </div>
            )}
          </section>
          <a className="reader-back" href={backHref} onClick={returnIntent}>
            ← Create another thread
          </a>
        </main>
      )}
      <div
        id="toast"
        className={toast ? 'show' : ''}
        role="status"
        aria-live="polite"
      >
        {toast}
      </div>
      {ready && modal && (
        <Dialog title={modalTitle} onClose={() => setModal(null)}>
          {modal.kind === 'appearance' ? (
            <AppearancePanel onClose={() => setModal(null)} />
          ) : modal.kind === 'library' ? (
            saved.length ? (
              saved.map((item) => (
                <div className="saved-item" key={item.id}>
                  <button
                    className="saved-open"
                    onClick={() => openRecord(item)}
                  >
                    {item.title}
                    <small>
                      {item.posts.length} tweets ·{' '}
                      {item.date || 'Saved on this device'}
                    </small>
                  </button>
                  <button
                    className="delete-saved"
                    aria-label={'Delete saved thread ' + item.title}
                    onClick={() =>
                      storeLibrary(
                        loadLibrary().filter((s) => s.id !== item.id),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ))
            ) : (
              <p>
                Your reading list starts here. Save a thread from its reading
                window to find it here later. Threads stay on this device.
              </p>
            )
          ) : modal.kind === 'about' ? (
            <>
              <p>
                Add a source: paste text, link a public article, or upload a
                text or Markdown file.
              </p>
              <p>
                Choose your depth. Your editable thread opens in a separate
                reading window.
              </p>
              <p>
                Threadly selects connected passages and keeps complete sentences
                in source order. It does not use generative AI. A summary may
                leave out context; return to the source when the details matter.
              </p>
              <p>
                Likes, reposts, bookmarks and replies are local and are not
                published to Twitter/X. Article media appears when available;
                PNG exports include available static images.
              </p>
              <p>
                Pasted text stays in your browser. Article links and images are
                fetched by the server. Saved threads stay on this device.
              </p>
            </>
          ) : modal.kind === 'reply' && record ? (
            <Replies
              key={record.id + modal.index}
              record={record}
              index={modal.index}
              onReply={(value) => {
                const state: Reaction = record.interactions[modal.index] || {
                  replies: [],
                }
                updateRecord(
                  {
                    ...record,
                    interactions: {
                      ...record.interactions,
                      [modal.index]: {
                        ...state,
                        replies: [
                          ...(state.replies || []),
                          { text: value, date: new Date().toISOString() },
                        ],
                      },
                    },
                  },
                  true,
                )
                notify('Reply saved on this device')
              }}
            />
          ) : modal.kind === 'media' ? (
            <>
              <img
                className="lightbox-image"
                src={mediaUrl(modal.item.url)}
                alt={modal.item.alt || 'Article image'}
              />
              {modal.item.caption && <p>{modal.item.caption}</p>}
              <a
                href={remoteUrl(modal.item.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open original image ↗
              </a>
            </>
          ) : modal.kind === 'export' && record ? (
            <ExportOptions
              record={record}
              selected={selected}
              onSelect={toggleSelection}
              onExport={(indices) => void exportImages(indices)}
              busy={exportBusy}
              onAppearance={() => setModal({ kind: 'appearance' })}
            />
          ) : null}
          {exportResult && ['export', 'result'].includes(modal.kind) && (
            <div className="export-result">
              <strong>Your image is ready</strong>
              {exportResult.png && (
                <img
                  src={exportResult.url}
                  alt="Preview of the exported tweets"
                />
              )}
              <a
                className="secondary"
                href={exportResult.url}
                download={exportResult.filename}
              >
                {exportResult.png ? 'Download PNG' : 'Download PNG pages (ZIP)'}
              </a>
            </div>
          )}
        </Dialog>
      )}
    </>
  )
}
function Replies({
  record,
  index,
  onReply,
}: {
  record: ThreadRecord
  index: number
  onReply: (text: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <>
      <p className="dialog-description">
        A space for your thoughts. Replies are saved on this device and are not
        published to Twitter/X.
      </p>
      <blockquote className="reply-quote">{record.posts[index]}</blockquote>
      <div className="local-replies">
        {record.interactions[index]?.replies?.map((r, i) => (
          <article key={i}>
            <strong>You</strong>
            <p>{r.text}</p>
          </article>
        ))}
      </div>
      <form
        className="reply-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) {
            onReply(value.trim())
            setValue('')
          }
        }}
      >
        <label htmlFor="replyText">Add a reply</label>
        <textarea
          id="replyText"
          maxLength={2000}
          placeholder="What does this idea make you think of?"
          required
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="copy-primary" type="submit" disabled={!value.trim()}>
          Add reply
        </button>
      </form>
    </>
  )
}
