type LogDetails = Record<string, unknown>

export function logGeneration(provider: string, event: string, details: LogDetails = {}): void {
  console.info(formatGenerationLog(provider, event, details))
}

export function logGenerationError(
  provider: string,
  event: string,
  error: unknown,
  details: LogDetails = {},
): void {
  const errorMessage = error instanceof Error ? error.message : String(error)
  console.error(formatGenerationLog(provider, event, { ...details, error: errorMessage }))
}

function formatGenerationLog(provider: string, event: string, details: LogDetails): string {
  const detailText = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ')
  return `[Higgsfilm][${provider}] ${new Date().toISOString()} ${event}${detailText ? ` ${detailText}` : ''}`
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
