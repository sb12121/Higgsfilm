import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ImageInspectorPayload } from '../shared/types'
import './inspector.css'

const emptyPayload: ImageInspectorPayload = {
  items: [],
  index: 0,
}

const SLIDESHOW_INTERVAL_MS = 2000

function ImageInspectorApp() {
  const [payload, setPayload] = useState<ImageInspectorPayload>(emptyPayload)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slideshow, setSlideshow] = useState(false)

  useEffect(() => window.imageInspector.onUpdate(setPayload), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        void window.imageInspector.navigate(1)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void window.imageInspector.navigate(-1)
        return
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        setSlideshow((current) => !current)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.imageInspector.close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const current = payload.items[payload.index]
  const total = payload.items.length
  const canGoNext = payload.index < total - 1

  useEffect(() => {
    if (!slideshow) return
    if (!canGoNext) {
      setSlideshow(false)
      return
    }
    const timer = window.setInterval(() => {
      void window.imageInspector.navigate(1)
    }, SLIDESHOW_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [slideshow, canGoNext, payload.index])

  useEffect(() => {
    let cancelled = false
    if (!current?.imagePath) {
      setImageUrl(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    void window.imageInspector
      .loadImage(current.imagePath)
      .then((asset) => {
        if (cancelled) return
        if (!asset?.dataUrl) {
          setImageUrl(null)
          setError('Could not load this image.')
          return
        }
        setImageUrl(asset.dataUrl)
      })
      .catch((loadError) => {
        if (cancelled) return
        setImageUrl(null)
        setError(loadError instanceof Error ? loadError.message : 'Could not load this image.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [current?.imagePath, current?.lineId])

  const position = total === 0 ? 0 : payload.index + 1
  const canGoPrevious = payload.index > 0

  return (
    <main className="inspector-shell">
      <header className="inspector-chrome">
        <div className="inspector-chrome-meta">
          <span className="eyebrow">
            {total === 0 ? 'No images' : `Image ${position} of ${total}`}
            {current ? ` · Line ${String(current.lineNumber).padStart(2, '0')}` : ''}
            {slideshow ? ' · Slideshow' : ''}
          </span>
          <strong title={current?.label || undefined}>
            {current?.label || 'Open an image from Visual direction'}
          </strong>
        </div>
        <div className="inspector-chrome-actions">
          <button
            type="button"
            className="inspector-button"
            aria-label="Previous image"
            disabled={!canGoPrevious}
            onClick={() => void window.imageInspector.navigate(-1)}
          >
            ←
          </button>
          <button
            type="button"
            className="inspector-button"
            aria-label="Next image"
            disabled={!canGoNext}
            onClick={() => void window.imageInspector.navigate(1)}
          >
            →
          </button>
          <button
            type="button"
            className={`inspector-button ${slideshow ? 'is-active' : ''}`}
            aria-label={slideshow ? 'Stop slideshow' : 'Start slideshow'}
            aria-pressed={slideshow}
            disabled={total < 2}
            onClick={() => setSlideshow((current) => !current)}
          >
            {slideshow ? 'Pause' : 'Slideshow'}
          </button>
          <button
            type="button"
            className="inspector-button is-close"
            aria-label="Close inspector"
            onClick={() => void window.imageInspector.close()}
          >
            Close
          </button>
        </div>
      </header>

      <section className="inspector-stage">
        {loading ? (
          <div className="inspector-loading">
            <strong>Loading image…</strong>
            <span>Full-resolution preview</span>
          </div>
        ) : error ? (
          <div className="inspector-empty">
            <strong>Preview unavailable</strong>
            <span>{error}</span>
          </div>
        ) : imageUrl ? (
          <img src={imageUrl} alt={current?.label || 'Scene preview'} />
        ) : (
          <div className="inspector-empty">
            <strong>No image selected</strong>
            <span>Choose a line with an assigned still in Visual direction.</span>
          </div>
        )}
      </section>

      <footer className="inspector-footer">
        <div className="inspector-hotkeys">
          <span>
            <kbd>←</kbd> previous
          </span>
          <span>
            <kbd>→</kbd> next
          </span>
          <span>
            <kbd>Space</kbd> slideshow
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
        <span>{slideshow ? 'Advancing every 2s' : 'Fits the full image in a centered window'}</span>
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<ImageInspectorApp />)
