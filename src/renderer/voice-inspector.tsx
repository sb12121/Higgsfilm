import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { VoiceInspectorPayload } from '../shared/types'
import { VoiceWaveformPreview } from './components/VoiceWaveformPreview'
import './voice-inspector.css'

const emptyPayload: VoiceInspectorPayload = {
  items: [],
  index: 0,
}

function VoiceInspectorApp() {
  const [payload, setPayload] = useState<VoiceInspectorPayload>(emptyPayload)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slideshow, setSlideshow] = useState(false)
  const [editBusy, setEditBusy] = useState(false)

  useEffect(() => window.voiceInspector.onUpdate(setPayload), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        void window.voiceInspector.navigate(1)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void window.voiceInspector.navigate(-1)
        return
      }
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        setSlideshow((current) => !current)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        void window.voiceInspector.close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const current = payload.items[payload.index]
  const total = payload.items.length
  const canGoNext = payload.index < total - 1
  const canGoPrevious = payload.index > 0

  useEffect(() => {
    let cancelled = false
    if (!current?.voicePath) {
      setAudioUrl(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    void window.voiceInspector
      .loadAudio(current.voicePath)
      .then((asset) => {
        if (cancelled) return
        if (!asset?.dataUrl) {
          setAudioUrl(null)
          setError('Could not load this take.')
          return
        }
        setAudioUrl(asset.dataUrl)
      })
      .catch((loadError) => {
        if (cancelled) return
        setAudioUrl(null)
        setError(loadError instanceof Error ? loadError.message : 'Could not load this take.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [current?.voicePath, current?.voiceAssetVersion, current?.lineId])

  useEffect(() => {
    if (!slideshow) return
    if (total < 2 && !canGoNext) {
      setSlideshow(false)
    }
  }, [slideshow, canGoNext, total])

  const position = total === 0 ? 0 : payload.index + 1

  return (
    <main className="inspector-shell">
      <header className="inspector-chrome">
        <div className="inspector-chrome-meta">
          <span className="eyebrow">
            {total === 0 ? 'No takes' : `Take ${position} of ${total}`}
            {current ? ` · Line ${String(current.lineNumber).padStart(2, '0')}` : ''}
            {slideshow ? ' · Slideshow' : ''}
          </span>
          <strong title={current?.label || undefined}>
            {current?.label || 'Open a take from Script & voice'}
          </strong>
        </div>
        <div className="inspector-chrome-actions">
          <button
            type="button"
            className="inspector-button"
            aria-label="Previous take"
            disabled={!canGoPrevious}
            onClick={() => void window.voiceInspector.navigate(-1)}
          >
            ←
          </button>
          <button
            type="button"
            className="inspector-button"
            aria-label="Next take"
            disabled={!canGoNext}
            onClick={() => void window.voiceInspector.navigate(1)}
          >
            →
          </button>
          <button
            type="button"
            className={`inspector-button ${slideshow ? 'is-active' : ''}`}
            aria-label={slideshow ? 'Stop slideshow' : 'Start slideshow'}
            aria-pressed={slideshow}
            disabled={total < 1}
            onClick={() => setSlideshow((value) => !value)}
          >
            {slideshow ? 'Pause' : 'Slideshow'}
          </button>
          <button
            type="button"
            className="inspector-button is-close"
            aria-label="Close inspector"
            onClick={() => void window.voiceInspector.close()}
          >
            Close
          </button>
        </div>
      </header>

      {current?.label ? (
        <div className="inspector-script">
          <p>{current.label}</p>
        </div>
      ) : null}

      <section className="inspector-stage">
        {loading ? (
          <div className="inspector-loading">
            <strong>Loading take…</strong>
            <span>Waveform and playback</span>
          </div>
        ) : error ? (
          <div className="inspector-empty">
            <strong>Preview unavailable</strong>
            <span>{error}</span>
          </div>
        ) : current && audioUrl ? (
          <VoiceWaveformPreview
            voicePath={current.voicePath}
            voiceAssetVersion={current.voiceAssetVersion}
            audioUrl={audioUrl}
            durationSeconds={current.durationSeconds}
            voiceTrimStart={current.voiceTrimStart}
            voiceCleanupVersion={current.voiceCleanupVersion}
            voiceCleanupEndPaddingSeconds={current.voiceCleanupEndPaddingSeconds}
            voiceCleanupConfident={current.voiceCleanupConfident}
            canTrim={current.canTrim}
            busy={editBusy}
            autoPlay={slideshow}
            loadPeaks={(relativePath, bucketCount) =>
              window.voiceInspector.audioPeaks(relativePath, bucketCount)
            }
            onPlaybackEnded={() => {
              if (!slideshow) return
              if (!canGoNext) {
                setSlideshow(false)
                return
              }
              void window.voiceInspector.navigate(1)
            }}
            onUserPause={() => {
              if (slideshow) setSlideshow(false)
            }}
            onTrim={(trimWindow) => {
              setEditBusy(true)
              setSlideshow(false)
              void window.voiceInspector
                .trimVoiceTake({
                  lineId: current.lineId,
                  sequence: current.sequence,
                  trimStartSeconds: trimWindow.trimStartSeconds,
                  trimEndSeconds: trimWindow.trimEndSeconds,
                })
                .finally(() => setEditBusy(false))
            }}
            onResetCleanup={() => {
              setEditBusy(true)
              setSlideshow(false)
              void window.voiceInspector
                .resetVoiceTakeCleanup({
                  lineId: current.lineId,
                  sequence: current.sequence,
                })
                .finally(() => setEditBusy(false))
            }}
          />
        ) : (
          <div className="inspector-empty">
            <strong>No take selected</strong>
            <span>Record or generate voice takes in Script & voice, then open the inspector.</span>
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
        <span>
          {slideshow
            ? 'Plays each take in full, then advances'
            : 'Centered waveform review with trim handles'}
        </span>
      </footer>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<VoiceInspectorApp />)
