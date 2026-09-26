import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SCRIPT_SPEAKER_LABEL } from '../shared/scriptSpeaker'
import type { RecordingFocusPayload } from '../shared/types'
import './overlay.css'

const initialPayload: RecordingFocusPayload = {
  text: '',
  lineNumber: 1,
  duration: 0,
  state: 'countdown',
  countdown: 3,
  leadInSeconds: 3,
}

function uniqueTones(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const tones: string[] = []
  for (const value of values || []) {
    const tone = value.trim()
    const key = tone.toLowerCase()
    if (!tone || seen.has(key)) continue
    seen.add(key)
    tones.push(tone)
  }
  return tones
}

function speakerClass(label: string | undefined): string {
  return label === SCRIPT_SPEAKER_LABEL.realization ? 'is-realization' : 'is-fool'
}

function TeleprompterOverlay() {
  const [payload, setPayload] = useState(initialPayload)

  useEffect(() => window.teleprompterOverlay.onUpdate(setPayload), [])

  const isCountdown = payload.state === 'countdown'
  const stanzaLines = payload.lines && payload.lines.length > 1 ? payload.lines : null
  const tones = uniqueTones(stanzaLines ? payload.expressions : payload.expression ? [payload.expression] : payload.expressions)
  const sharedTone = tones.length === 1 ? tones[0] : payload.expression
  const mixedTones = Boolean(stanzaLines && tones.length > 1)
  const speakers = uniqueTones(stanzaLines ? payload.speakers : payload.speaker ? [payload.speaker] : payload.speakers)
  const sharedSpeaker = speakers.length === 1 ? speakers[0] : payload.speaker
  const mixedSpeakers = Boolean(stanzaLines && speakers.length > 1)
  const label = payload.stanzaNumber
    ? `STANZA ${String(payload.stanzaNumber).padStart(2, '0')}`
    : `LINE ${String(payload.lineNumber).padStart(2, '0')}`

  return (
    <main
      className={`teleprompter-overlay ${isCountdown ? 'is-countdown' : 'is-recording'} ${
        sharedSpeaker && !mixedSpeakers ? speakerClass(sharedSpeaker) : ''
      }`}
    >
      <section className="teleprompter-card">
        <div className="teleprompter-topline">
          <span>HIGGSFILM TELEPROMPTER</span>
          <span>{label}</span>
        </div>
        <div className="teleprompter-copy">
          {sharedSpeaker && !mixedSpeakers ? (
            <p className={`teleprompter-speaker ${speakerClass(sharedSpeaker)}`}>
              {sharedSpeaker}
              {payload.speakerHint ? <small>{payload.speakerHint}</small> : null}
            </p>
          ) : null}
          {sharedTone && !mixedTones ? <p className="teleprompter-tone">{sharedTone}</p> : null}
          {stanzaLines ? (
            <div className="teleprompter-script teleprompter-stanza">
              {stanzaLines.map((line, index) => (
                <div className="teleprompter-beat" key={`${index}-${line}`}>
                  {mixedSpeakers && payload.speakers?.[index] ? (
                    <span className={`teleprompter-speaker ${speakerClass(payload.speakers[index])}`}>
                      {payload.speakers[index]}
                    </span>
                  ) : null}
                  {mixedTones && payload.expressions?.[index] ? (
                    <span className="teleprompter-tone">{payload.expressions[index]}</span>
                  ) : null}
                  <p>{line}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="teleprompter-script">{payload.text}</p>
          )}
        </div>
        <div className="teleprompter-status">
          {isCountdown ? (
            <>
              <span>STARTING IN</span>
              <strong>{payload.countdown ?? payload.leadInSeconds}</strong>
            </>
          ) : (
            <>
              <span className="teleprompter-dot" />
              <span>
                {payload.stanzaNumber
                  ? 'RECORDING STANZA · SHORT PAUSE SAVES + NEXT · ENTER NOW · LEFT GOES BACK · ESC REDOES'
                  : 'RECORDING · SHORT PAUSE SAVES + NEXT · ENTER NOW · LEFT GOES BACK · ESC REDOES'}
              </span>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<TeleprompterOverlay />)
