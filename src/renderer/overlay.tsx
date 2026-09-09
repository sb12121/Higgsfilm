import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
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

function TeleprompterOverlay() {
  const [payload, setPayload] = useState(initialPayload)

  useEffect(() => window.teleprompterOverlay.onUpdate(setPayload), [])

  const isCountdown = payload.state === 'countdown'

  return (
    <main className={`teleprompter-overlay ${isCountdown ? 'is-countdown' : 'is-recording'}`}>
      <section className="teleprompter-card">
        <div className="teleprompter-topline">
          <span>HIGGSFILM TELEPROMPTER</span>
          <span>LINE {String(payload.lineNumber).padStart(2, '0')}</span>
        </div>
        <p className="teleprompter-script">{payload.text}</p>
        <div className="teleprompter-status">
          {isCountdown ? (
            <>
              <span>STARTING IN</span>
              <strong>{payload.countdown ?? payload.leadInSeconds}</strong>
            </>
          ) : (
            <>
              <span className="teleprompter-dot" />
              <span>RECORDING · SILENCE AUTO-SAVES + NEXT · ENTER NOW · ESC REDOES</span>
            </>
          )}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<TeleprompterOverlay />)
