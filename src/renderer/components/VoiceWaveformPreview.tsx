import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Pause, Play, RotateCcw } from 'lucide-react'
import {
  rawTrimEndFromCleanedEnd,
  rawTrimStartFromCleanedStart,
} from '../../shared/voiceCleanupMath'

const PEAK_BUCKETS = 220
const HANDLE_HIT_PX = 16
const MIN_KEEP_SECONDS = 0.25

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds)
  const whole = Math.floor(safe)
  const tenths = Math.floor((safe - whole) * 10)
  const minutes = Math.floor(whole / 60)
  const remainder = whole % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}.${tenths}`
}

type TrimHandle = 'start' | 'end'

export function VoiceWaveformPreview({
  voicePath,
  voiceAssetVersion,
  audioUrl,
  durationSeconds,
  voiceTrimStart,
  voiceCleanupVersion,
  voiceCleanupEndPaddingSeconds,
  voiceCleanupConfident,
  canTrim,
  busy = false,
  autoPlay = false,
  loadPeaks,
  onTrim,
  onResetCleanup,
  onPlaybackEnded,
  onUserPause,
}: {
  voicePath?: string
  voiceAssetVersion?: string
  audioUrl?: string
  durationSeconds: number
  voiceTrimStart?: number
  voiceCleanupVersion?: number
  voiceCleanupEndPaddingSeconds?: number
  voiceCleanupConfident?: boolean
  canTrim: boolean
  busy?: boolean
  autoPlay?: boolean
  loadPeaks?: (relativePath: string, bucketCount: number) => Promise<number[] | null>
  onTrim: (window: { trimStartSeconds: number; trimEndSeconds: number }) => void
  onResetCleanup: () => void
  onPlaybackEnded?: () => void
  onUserPause?: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const peaksRef = useRef<number[]>([])
  const [peaks, setPeaks] = useState<number[]>([])
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [previewStart, setPreviewStart] = useState(0)
  const [previewEnd, setPreviewEnd] = useState(durationSeconds)
  const previewStartRef = useRef(0)
  const previewEndRef = useRef(durationSeconds)
  const [dragging, setDragging] = useState<TrimHandle | null>(null)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [peaksLoading, setPeaksLoading] = useState(false)
  const endedReportedRef = useRef(false)

  useEffect(() => {
    previewStartRef.current = 0
    previewEndRef.current = durationSeconds
    setPreviewStart(0)
    setPreviewEnd(durationSeconds)
    setCurrentTime(0)
    setPlaying(false)
    endedReportedRef.current = false
  }, [audioUrl, durationSeconds, voiceAssetVersion])

  useEffect(() => {
    if (!voicePath) {
      peaksRef.current = []
      setPeaks([])
      setDecodeError(null)
      setPeaksLoading(false)
      return
    }

    let cancelled = false
    setPeaksLoading(true)

    async function loadPeaksData() {
      try {
        const loader =
          loadPeaks ||
          ((relativePath: string, bucketCount: number) =>
            window.studio.project.audioPeaks(relativePath, bucketCount))
        const nextPeaks = await loader(voicePath!, PEAK_BUCKETS)
        if (cancelled) return
        if (!nextPeaks || nextPeaks.length === 0) {
          peaksRef.current = []
          setPeaks([])
          setDecodeError('Could not decode this take for waveform preview.')
          return
        }
        peaksRef.current = nextPeaks
        setPeaks(nextPeaks)
        setDecodeError(null)
      } catch {
        if (cancelled) return
        peaksRef.current = []
        setPeaks([])
        setDecodeError('Could not decode this take for waveform preview.')
      } finally {
        if (!cancelled) setPeaksLoading(false)
      }
    }

    void loadPeaksData()
    return () => {
      cancelled = true
    }
  }, [voicePath, voiceAssetVersion, loadPeaks])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width <= 0 || height <= 0) return
    const ratio = window.devicePixelRatio || 1
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const midY = height / 2
    const usable = peaksRef.current.length > 0 ? peaksRef.current : peaks
    const duration = Math.max(0.1, durationSeconds)
    const startRatio = Math.min(1, Math.max(0, previewStart / duration))
    const endRatio = Math.min(1, Math.max(startRatio + 0.02, previewEnd / duration))

    ctx.fillStyle = 'rgba(130, 217, 228, 0.08)'
    ctx.fillRect(width * startRatio, 0, width * (endRatio - startRatio), height)

    if (usable.length === 0) {
      ctx.strokeStyle = 'rgba(130, 217, 228, 0.35)'
      ctx.beginPath()
      ctx.moveTo(0, midY)
      ctx.lineTo(width, midY)
      ctx.stroke()
    } else {
      const barWidth = width / usable.length
      usable.forEach((peak, index) => {
        const x = index * barWidth
        const barHeight = Math.max(2, peak * (height * 0.72))
        const ratioAtBar = index / usable.length
        const kept = ratioAtBar >= startRatio && ratioAtBar <= endRatio
        ctx.fillStyle = kept ? 'rgba(130, 217, 228, 0.78)' : 'rgba(90, 104, 122, 0.35)'
        ctx.fillRect(x + 0.5, midY - barHeight / 2, Math.max(1, barWidth - 1), barHeight)
      })
    }

    const playheadX = (Math.min(Math.max(currentTime, previewStart), previewEnd) / duration) * width
    ctx.strokeStyle = 'rgba(255, 214, 153, 0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(playheadX, 8)
    ctx.lineTo(playheadX, height - 8)
    ctx.stroke()

    drawHandle(ctx, startRatio * width, midY, height)
    drawHandle(ctx, endRatio * width, midY, height)
  }, [currentTime, durationSeconds, peaks, previewEnd, previewStart])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const finishPlayback = () => {
      if (endedReportedRef.current) return
      endedReportedRef.current = true
      audio.pause()
      audio.currentTime = previewStart
      setPlaying(false)
      setCurrentTime(previewStart)
      onPlaybackEnded?.()
    }
    const onTime = () => {
      if (audio.currentTime >= previewEnd - 0.02) {
        finishPlayback()
        return
      }
      setCurrentTime(audio.currentTime)
    }
    const onEnded = () => {
      finishPlayback()
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('ended', onEnded)
    }
  }, [audioUrl, onPlaybackEnded, previewEnd, previewStart])

  useEffect(() => {
    if (!autoPlay || !audioUrl || busy) return
    const audio = audioRef.current
    if (!audio) return
    let cancelled = false
    const start = window.setTimeout(() => {
      if (cancelled) return
      endedReportedRef.current = false
      audio.currentTime = previewStartRef.current
      void audio
        .play()
        .then(() => {
          if (!cancelled) setPlaying(true)
        })
        .catch(() => {
          if (!cancelled) setPlaying(false)
        })
    }, 40)
    return () => {
      cancelled = true
      window.clearTimeout(start)
    }
  }, [autoPlay, audioUrl, busy, voiceAssetVersion])

  function togglePlayback() {
    const audio = audioRef.current
    if (!audio || !audioUrl) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      onUserPause?.()
      return
    }
    endedReportedRef.current = false
    audio.currentTime = previewStart
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
  }

  function pointerToSeconds(clientX: number): number {
    const canvas = canvasRef.current
    if (!canvas) return previewEnd
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / Math.max(1, bounds.width)))
    return Number((ratio * Math.max(0.1, durationSeconds)).toFixed(3))
  }

  function handleAtPointer(clientX: number): TrimHandle {
    const canvas = canvasRef.current
    if (!canvas) return 'end'
    const bounds = canvas.getBoundingClientRect()
    const x = clientX - bounds.left
    const duration = Math.max(0.1, durationSeconds)
    const startX = (previewStart / duration) * bounds.width
    const endX = (previewEnd / duration) * bounds.width
    const distStart = Math.abs(x - startX)
    const distEnd = Math.abs(x - endX)
    if (distStart <= HANDLE_HIT_PX || distEnd <= HANDLE_HIT_PX) {
      return distStart <= distEnd ? 'start' : 'end'
    }
    return distStart < distEnd ? 'start' : 'end'
  }

  function beginDrag(clientX: number) {
    if (!canTrim || busy || typeof voiceTrimStart !== 'number') return
    const handle = handleAtPointer(clientX)
    setDragging(handle)
    applyDrag(handle, pointerToSeconds(clientX))
  }

  function applyDrag(handle: TrimHandle, seconds: number): { start: number; end: number } {
    const duration = Math.max(0.1, durationSeconds)
    const currentStart = previewStartRef.current
    const currentEnd = previewEndRef.current
    const start =
      handle === 'start'
        ? Number(Math.min(currentEnd - MIN_KEEP_SECONDS, Math.max(0, seconds)).toFixed(3))
        : currentStart
    const end =
      handle === 'end'
        ? Number(Math.min(duration, Math.max(currentStart + MIN_KEEP_SECONDS, seconds)).toFixed(3))
        : currentEnd
    previewStartRef.current = start
    previewEndRef.current = end
    setPreviewStart(start)
    setPreviewEnd(end)
    return { start, end }
  }

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      applyDrag(dragging, pointerToSeconds(event.clientX))
    }
    const onUp = (event: PointerEvent) => {
      const { start, end } = applyDrag(dragging, pointerToSeconds(event.clientX))
      setDragging(null)
      if (typeof voiceTrimStart !== 'number') return
      const startUnchanged = start < 0.02
      const endUnchanged = Math.abs(end - durationSeconds) < 0.02
      if (startUnchanged && endUnchanged) return
      const usesOutgoingEndGap = voiceCleanupVersion === 2
      onTrim({
        trimStartSeconds: rawTrimStartFromCleanedStart(
          start,
          voiceTrimStart,
          usesOutgoingEndGap ? 0 : undefined,
        ),
        trimEndSeconds: rawTrimEndFromCleanedEnd(
          end,
          voiceTrimStart,
          usesOutgoingEndGap ? 0 : undefined,
          usesOutgoingEndGap ? voiceCleanupEndPaddingSeconds ?? 0.25 : undefined,
        ),
      })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [
    dragging,
    durationSeconds,
    onTrim,
    voiceCleanupEndPaddingSeconds,
    voiceCleanupVersion,
    voiceTrimStart,
  ])

  if (!audioUrl && !voicePath) {
    return (
      <div className="scene-preview-large voice-preview-large">
        <div className="scene-preview-empty">
          <Mic size={28} />
          <strong>No take yet</strong>
          <span>Record or generate this line to preview audio.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="voice-preview-stack">
      <div className={`scene-preview-large voice-preview-large ${busy || peaksLoading ? 'is-busy' : ''}`}>
        <canvas
          ref={canvasRef}
          className="voice-waveform-canvas"
          onPointerDown={(event) => {
            event.preventDefault()
            beginDrag(event.clientX)
          }}
        />
        {busy || peaksLoading ? (
          <div className="voice-preview-busy" role="status">
            <LoaderCircle size={18} className="spin" />
            <span>{busy ? 'Updating take…' : 'Loading waveform…'}</span>
          </div>
        ) : null}
        {decodeError ? <p className="voice-preview-error">{decodeError}</p> : null}
      </div>
      {audioUrl ? <audio ref={audioRef} src={audioUrl} preload="auto" /> : null}
      <div className="voice-preview-toolbar">
        <button className="button button-secondary" onClick={togglePlayback} disabled={busy || !audioUrl}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="voice-preview-time">
          {formatClock(previewStart)} – {formatClock(previewEnd)}
        </span>
        {canTrim ? (
          <button
            className="button button-quiet"
            onClick={onResetCleanup}
            disabled={busy}
            title="Re-run auto-trim from the saved raw take with a 250 ms outgoing-scene end gap"
          >
            <RotateCcw size={14} />
            Re-run auto-trim
          </button>
        ) : (
          <span className="subtle-label">Playback only · re-record to enable trim</span>
        )}
      </div>
      {canTrim ? (
        <p className="voice-preview-hint">Drag the left handle to trim the start, right handle to trim the end.</p>
      ) : null}
      {voiceCleanupVersion === 2 && voiceCleanupConfident === false ? (
        <p className="voice-preview-hint">Speech boundaries uncertain; raw take preserved. Check the trim.</p>
      ) : null}
    </div>
  )
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  midY: number,
  height: number,
): void {
  ctx.fillStyle = '#82d9e4'
  ctx.fillRect(x - 1, 6, 2, height - 12)
  ctx.beginPath()
  ctx.arc(x, midY, 7, 0, Math.PI * 2)
  ctx.fill()
}
