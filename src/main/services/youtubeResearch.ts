import type {
  VideoIdeaResearchRequest,
  VideoIdeaResearchResult,
  YouTubeChannelSnapshot,
  YouTubeVideoHit,
} from '../../shared/types'

const YOUTUBE_ORIGIN = 'https://www.youtube.com'
const INNERTUBE_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20240815.00.00',
  hl: 'en',
  gl: 'US',
}
const SEARCH_LIMIT = 10
const CHANNEL_VIDEO_LIMIT = 8
const QUERY_LIMIT = 3
const CHANNEL_LIMIT = 2
const REQUEST_TIMEOUT_MS = 20_000
const CHANNEL_VIDEOS_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA'

type FetchLike = typeof fetch

export async function researchYouTube(
  input: VideoIdeaResearchRequest,
  fetchImpl: FetchLike = fetch,
): Promise<VideoIdeaResearchResult> {
  const queries = uniqueStrings(input.queries).slice(0, QUERY_LIMIT)
  const channels = uniqueStrings(input.channels).slice(0, CHANNEL_LIMIT)
  const queryResults: VideoIdeaResearchResult['queries'] = []
  const channelResults: VideoIdeaResearchResult['channels'] = []

  for (const query of queries) {
    try {
      queryResults.push({ query, videos: await searchYouTube(query, fetchImpl) })
    } catch (error) {
      queryResults.push({
        query,
        videos: [],
        error: error instanceof Error ? error.message : 'YouTube search failed.',
      })
    }
  }

  for (const channel of channels) {
    try {
      channelResults.push({ channel, snapshot: await inspectYouTubeChannel(channel, fetchImpl) })
    } catch (error) {
      channelResults.push({
        channel,
        error: error instanceof Error ? error.message : 'YouTube channel lookup failed.',
      })
    }
  }

  return { queries: queryResults, channels: channelResults }
}

export async function searchYouTube(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<YouTubeVideoHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const payload = await innertube(fetchImpl, 'search', { query: trimmed })
  return collectVideos(payload).slice(0, SEARCH_LIMIT)
}

export async function inspectYouTubeChannel(
  channel: string,
  fetchImpl: FetchLike = fetch,
): Promise<YouTubeChannelSnapshot> {
  const resolved = await resolveChannel(channel.trim(), fetchImpl)
  const payload = await innertube(fetchImpl, 'browse', {
    browseId: resolved.channelId,
    params: CHANNEL_VIDEOS_PARAMS,
  })
  const name = readChannelName(payload) || resolved.name || resolved.channelId
  // Keep Videos-tab order (newest first); view totals alone do not establish outliers.
  const videos = collectVideos(payload)
    .slice(0, CHANNEL_VIDEO_LIMIT)
    .map((video) => ({
      ...video,
      channelName:
        video.channelName && video.channelName !== 'Unknown channel' ? video.channelName : name,
      channelId: video.channelId || resolved.channelId,
    }))
  return {
    channelId: resolved.channelId,
    name,
    handle: resolved.handle,
    url: resolved.handle
      ? `${YOUTUBE_ORIGIN}/${resolved.handle.startsWith('@') ? resolved.handle : `@${resolved.handle}`}`
      : `${YOUTUBE_ORIGIN}/channel/${resolved.channelId}`,
    videos,
  }
}

export function collectVideos(payload: unknown): YouTubeVideoHit[] {
  const videos: YouTubeVideoHit[] = []
  const seen = new Set<string>()
  walk(payload, (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    const classic =
      record.videoRenderer || record.videoWithContextRenderer || record.gridVideoRenderer
    const lockup = record.lockupViewModel
    const video = classic && typeof classic === 'object'
      ? parseVideoRenderer(classic as Record<string, unknown>)
      : lockup && typeof lockup === 'object'
        ? parseLockupViewModel(lockup as Record<string, unknown>)
        : null
    if (!video || seen.has(video.videoId)) return
    seen.add(video.videoId)
    videos.push(video)
  })
  return videos
}

export function parseViewCount(value: string | undefined): number | undefined {
  if (!value) return undefined
  const normalized = value.replace(/,/g, '').trim()
  const match = normalized.match(/([\d.]+)\s*([kmb])?/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const suffix = (match[2] || '').toLowerCase()
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1
  return Math.round(amount * multiplier)
}

async function resolveChannel(
  channel: string,
  fetchImpl: FetchLike,
): Promise<{ channelId: string; name?: string; handle?: string }> {
  if (/^UC[\w-]{20,}$/.test(channel)) return { channelId: channel }
  const handle = youtubeChannelHandle(channel)
  const url = `${YOUTUBE_ORIGIN}/${handle}`
  const html = await readText(fetchImpl, url)
  const browseId = html.match(/"browseId":"(UC[\w-]{20,})"/)?.[1]
  const name = html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1]
  if (!browseId) throw new Error(`Could not resolve YouTube channel "${channel}".`)
  return { channelId: browseId, name, handle: handle.startsWith('@') ? handle : undefined }
}

async function innertube(
  fetchImpl: FetchLike,
  endpoint: 'search' | 'browse',
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(`${YOUTUBE_ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: youtubeHeaders(),
    body: JSON.stringify({
      context: { client: INNERTUBE_CLIENT },
      ...body,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`YouTube ${endpoint} returned ${response.status}.`)
  }
  return response.json()
}

async function readText(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    headers: youtubeHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`YouTube returned ${response.status} for ${url}.`)
  return response.text()
}

function youtubeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: YOUTUBE_ORIGIN,
    Referer: `${YOUTUBE_ORIGIN}/`,
  }
}

function parseVideoRenderer(renderer: Record<string, unknown>): YouTubeVideoHit | null {
  const videoId = readString(renderer.videoId)
  if (!videoId) return null
  const title = textOf(renderer.title)
  if (!title) return null
  const viewCountText = textOf(renderer.viewCountText) || textOf(renderer.shortViewCountText)
  return {
    videoId,
    title,
    channelName: textOf(renderer.ownerText) || textOf(renderer.shortBylineText) || 'Unknown channel',
    channelId: browseIdOf(renderer.ownerText) || browseIdOf(renderer.shortBylineText),
    url: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    viewCount: parseViewCount(viewCountText),
    viewCountText: viewCountText || undefined,
    published: textOf(renderer.publishedTimeText) || undefined,
    duration: textOf(renderer.lengthText) || undefined,
    description: textOf(renderer.descriptionSnippet) || undefined,
  }
}

/** YouTube's current channel Videos tab uses lockupViewModel instead of videoRenderer. */
function parseLockupViewModel(lockup: Record<string, unknown>): YouTubeVideoHit | null {
  if (readString(lockup.contentType) && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
    return null
  }
  const videoId = readString(lockup.contentId)
  if (!videoId || videoId.length < 6) return null

  const metadata =
    lockup.metadata && typeof lockup.metadata === 'object'
      ? (lockup.metadata as Record<string, unknown>).lockupMetadataViewModel
      : undefined
  const meta =
    metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : undefined
  const title = textOf(meta?.title)
  if (!title) return null

  const parts = lockupMetadataParts(meta)
  const viewCountText = parts.find((part) => /view/i.test(part)) || parts[0] || ''
  const published = parts.find((part) => /ago|streamed|premiere|scheduled/i.test(part)) || parts[1]

  return {
    videoId,
    title,
    channelName: 'Unknown channel',
    url: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    viewCount: parseViewCount(viewCountText),
    viewCountText: viewCountText || undefined,
    published: published || undefined,
    duration: lockupDuration(lockup) || undefined,
  }
}

function lockupMetadataParts(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) return []
  const contentMeta =
    meta.metadata && typeof meta.metadata === 'object'
      ? (meta.metadata as Record<string, unknown>).contentMetadataViewModel
      : undefined
  if (!contentMeta || typeof contentMeta !== 'object') return []
  const rows = (contentMeta as { metadataRows?: unknown }).metadataRows
  if (!Array.isArray(rows)) return []
  const parts: string[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const metadataParts = (row as { metadataParts?: unknown }).metadataParts
    if (!Array.isArray(metadataParts)) continue
    for (const part of metadataParts) {
      if (!part || typeof part !== 'object') continue
      const text = textOf((part as { text?: unknown }).text)
      if (text) parts.push(text)
    }
  }
  return parts
}

function lockupDuration(lockup: Record<string, unknown>): string {
  let duration = ''
  walk(lockup.contentImage, (node) => {
    if (duration || !node || typeof node !== 'object' || Array.isArray(node)) return
    const badge = (node as { thumbnailBadgeViewModel?: unknown }).thumbnailBadgeViewModel
    if (!badge || typeof badge !== 'object') return
    const text = textOf((badge as { text?: unknown }).text)
    // Prefer clock-style durations over "Now playing".
    if (/^\d+:\d+/.test(text)) duration = text
  })
  return duration
}

function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.content === 'string') return record.content.trim()
  if (typeof record.simpleText === 'string') return record.simpleText.trim()
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((run) => (run && typeof run === 'object' ? readString((run as { text?: unknown }).text) : ''))
      .join('')
      .trim()
  }
  return ''
}

function browseIdOf(value: unknown): string | undefined {
  let found: string | undefined
  walk(value, (node) => {
    if (found || !node || typeof node !== 'object' || Array.isArray(node)) return
    const browseId = readString((node as { browseId?: unknown }).browseId)
    if (/^UC[\w-]{20,}$/.test(browseId)) found = browseId
  })
  return found
}

function readChannelName(payload: unknown): string {
  let name = ''
  walk(payload, (node) => {
    if (name || !node || typeof node !== 'object' || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    if (record.channelMetadataRenderer && typeof record.channelMetadataRenderer === 'object') {
      name = readString((record.channelMetadataRenderer as { title?: unknown }).title)
    }
  })
  return name
}

function walk(value: unknown, visit: (node: unknown) => void): void {
  visit(value)
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  for (const item of Object.values(value as Record<string, unknown>)) walk(item, visit)
}

export function youtubeChannelHandle(channel: string): string {
  const trimmed = channel.trim()
  const stripped = trimmed
    .replace(/^https?:\/\/(www\.)?youtube\.com\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .replace(/\s+/g, '')
  return `@${stripped}`
}

function uniqueStrings(values: string[] | undefined): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const value of values || []) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    next.push(trimmed)
  }
  return next
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
