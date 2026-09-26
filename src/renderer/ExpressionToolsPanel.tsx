import { useEffect, useState } from 'react'
import { Image as ImageIcon, LoaderCircle, Square, WandSparkles, X } from 'lucide-react'
import type { ExpressionImageProgress, ExpressionImageSetup, StudioSettings } from '../shared/types'

const MAX_FACE_REFERENCES = 4

function fileNameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

export function ExpressionToolsPanel({
  libraryPath,
  authenticated,
  onLogin,
  onNotice,
  onSettingsSaved,
  onLibraryChanged,
}: {
  libraryPath: string
  authenticated: boolean
  onLogin: () => void
  onNotice: (type: 'success' | 'error' | 'info', message: string) => void
  onSettingsSaved: (settings: StudioSettings) => void
  onLibraryChanged: () => void
}) {
  const [setup, setSetup] = useState<ExpressionImageSetup | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExpressionImageProgress | null>(null)

  async function refresh(): Promise<ExpressionImageSetup | null> {
    try {
      const next = await window.studio.expressionImages.getSetup()
      setSetup(next)
      setSelected((current) => current.filter((name) => next.expressions.includes(name)))
      return next
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : 'Could not load expression tools.')
      return null
    }
  }

  useEffect(() => {
    void refresh()
  }, [libraryPath])

  useEffect(() => window.studio.expressionImages.onProgress(setProgress), [])

  async function savePatch(patch: Partial<StudioSettings>, message: string): Promise<void> {
    const current = await window.studio.settings.get()
    const saved = await window.studio.settings.save({ ...current, ...patch })
    onSettingsSaved(saved)
    await refresh()
    onNotice('success', message)
  }

  async function chooseGuide(): Promise<void> {
    const chosen = await window.studio.expressionImages.chooseGuide()
    if (!chosen) return
    await savePatch({ expressionGuidePath: chosen }, `Expression guide set to ${fileNameFromPath(chosen)}.`)
  }

  async function chooseCharacterSheet(): Promise<void> {
    const chosen = await window.studio.customImages.chooseCharacterSheet()
    if (!chosen) return
    const current = await window.studio.settings.get()
    await savePatch(
      {
        customImageCharacterSheetPath: chosen,
        customImageReferencePaths: current.customImageReferencePaths.filter(
          (existing) => existing.toLowerCase() !== chosen.toLowerCase(),
        ),
      },
      `Character sheet set to ${fileNameFromPath(chosen)}.`,
    )
  }

  async function addReferences(): Promise<void> {
    const chosen = await window.studio.customImages.chooseReferences()
    if (!chosen || chosen.length === 0) return
    const current = await window.studio.settings.get()
    const blocked = new Set(
      [current.customImageCharacterSheetPath, current.expressionBackgroundPath]
        .map((filePath) => filePath.toLowerCase())
        .filter(Boolean),
    )
    const merged = [...current.customImageReferencePaths]
    for (const filePath of chosen) {
      if (blocked.has(filePath.toLowerCase())) continue
      if (merged.some((existing) => existing.toLowerCase() === filePath.toLowerCase())) continue
      merged.push(filePath)
    }
    await savePatch(
      { customImageReferencePaths: merged.slice(0, MAX_FACE_REFERENCES) },
      merged.length === 1 ? 'Reference image added.' : `${Math.min(merged.length, MAX_FACE_REFERENCES)} reference images saved.`,
    )
  }

  async function removeReference(filePath: string): Promise<void> {
    const current = await window.studio.settings.get()
    const saved = await window.studio.settings.save({
      ...current,
      customImageReferencePaths: current.customImageReferencePaths.filter((existing) => existing !== filePath),
    })
    onSettingsSaved(saved)
    await refresh()
  }

  async function chooseBackground(): Promise<void> {
    const chosen = await window.studio.expressionImages.chooseBackground()
    if (!chosen) return
    await savePatch(
      { expressionBackgroundPath: chosen },
      `Shared background set to ${fileNameFromPath(chosen)}.`,
    )
  }

  function toggleExpression(name: string): void {
    setSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    )
  }

  async function generate(): Promise<void> {
    if (selected.length === 0 || busy) return
    setBusy(true)
    setProgress(null)
    try {
      const result = await window.studio.expressionImages.generate({ expressions: selected })
      onLibraryChanged()
      onNotice(
        result.stopped ? 'info' : 'success',
        result.stopped
          ? 'Expression regeneration stopped. Finished frames stay in the Expressions folder.'
          : `Regenerated ${result.written.length} expression frame${result.written.length === 1 ? '' : 's'}.`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Expression regeneration failed.'
      onNotice(/cancelled/i.test(message) ? 'info' : 'error', message)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const expressions = setup?.expressions || []
  const references = setup?.referencePaths || []
  const ready = Boolean(
    authenticated && setup?.guidePath && setup.characterSheetPath && setup.backgroundPath && setup.libraryPath,
  )

  return (
    <section className="custom-image-panel expression-tools">
      <div className="custom-image-panel-heading">
        <div>
          <div className="eyebrow">Outside the episode workflow</div>
          <h2>Regenerate expressions</h2>
        </div>
        {busy ? (
          <button className="button button-quiet" onClick={() => void window.studio.expressionImages.cancel()}>
            <Square size={14} />
            Stop
          </button>
        ) : null}
      </div>
      <p>
        Writes a new 01, 02, and 03 into the channel Expressions folder for each expression you pick.
        Every frame uses the character sheet, the face references, and this one background. Each frame
        is saved at 3840×2160. This replaces the stills already in those folders.
      </p>
      <div className="custom-image-setup">
        <div>
          <span className="field-label">Guide</span>
          <strong title={setup?.guidePath || undefined}>
            {setup?.guidePath ? fileNameFromPath(setup.guidePath) : 'Not found yet'}
          </strong>
          <button className="button button-quiet" onClick={() => void chooseGuide()} disabled={busy}>
            Choose guide
          </button>
        </div>
        <div>
          <span className="field-label">Character sheet</span>
          <strong title={setup?.characterSheetPath || undefined}>
            {setup?.characterSheetPath ? fileNameFromPath(setup.characterSheetPath) : 'Required'}
          </strong>
          <button className="button button-quiet" onClick={() => void chooseCharacterSheet()} disabled={busy}>
            <ImageIcon size={14} />
            {setup?.characterSheetPath ? 'Replace sheet' : 'Choose sheet'}
          </button>
        </div>
        <div>
          <span className="field-label">Face references</span>
          <strong>{references.length === 0 ? 'Optional' : `${references.length} of ${MAX_FACE_REFERENCES}`}</strong>
          <button
            className="button button-quiet"
            onClick={() => void addReferences()}
            disabled={busy || references.length >= MAX_FACE_REFERENCES}
          >
            <ImageIcon size={14} />
            Add references
          </button>
        </div>
        <div>
          <span className="field-label">Background</span>
          <strong title={setup?.backgroundPath || undefined}>
            {setup?.backgroundPath ? fileNameFromPath(setup.backgroundPath) : 'One empty plate'}
          </strong>
          <button className="button button-quiet" onClick={() => void chooseBackground()} disabled={busy}>
            <ImageIcon size={14} />
            {setup?.backgroundPath ? 'Replace background' : 'Choose background'}
          </button>
        </div>
      </div>
      {references.length > 0 ? (
        <div className="custom-image-references">
          {references.map((filePath) => (
            <span className="custom-image-reference" key={filePath}>
              {fileNameFromPath(filePath)}
              <button
                type="button"
                aria-label={`Remove ${fileNameFromPath(filePath)}`}
                onClick={() => void removeReference(filePath)}
                disabled={busy}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="expression-tool-list-heading">
        <span className="field-label">
          {setup?.libraryPath ? `${expressions.length} expressions` : 'Choose a channel folder first'}
        </span>
        <button
          className="button button-quiet"
          type="button"
          disabled={busy || expressions.length === 0}
          onClick={() => setSelected(selected.length === expressions.length ? [] : expressions)}
        >
          {selected.length === expressions.length && expressions.length > 0 ? 'Clear' : 'Select all'}
        </button>
      </div>
      <div className="expression-tool-list">
        {expressions.map((name) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={selected.includes(name)}
              disabled={busy}
              onChange={() => toggleExpression(name)}
            />
            {name}
          </label>
        ))}
      </div>
      {progress && busy ? (
        <div className="custom-image-progress" role="status">
          <LoaderCircle size={14} className="spin" />
          <span>
            {progress.phase === 'saving' ? 'Saving' : 'Generating'} {progress.expression} {progress.fileName} (
            {progress.index} of {progress.total})
          </span>
        </div>
      ) : null}
      <div className="custom-image-actions">
        {authenticated ? null : (
          <button className="button button-secondary" onClick={onLogin} disabled={busy}>
            Sign in to ChatGPT
          </button>
        )}
        <button
          className="button button-primary"
          onClick={() => void generate()}
          disabled={!ready || busy || selected.length === 0}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}
          Regenerate selected{selected.length > 0 ? ` (${selected.length * 3})` : ''}
        </button>
      </div>
    </section>
  )
}
