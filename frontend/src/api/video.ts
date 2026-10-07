import { buildGatewayUrl } from './client'

export type VideoStatus =
  | 'queued'
  | 'in_progress'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired'
  | string

export interface CreateVideoRequest {
  prompt: string
  model: string
  seconds: number
  resolution: string
  aspect_ratio: string
}

export interface VideoJob {
  id: string
  status: VideoStatus
  model?: string
  prompt?: string
  seconds?: number
  resolution?: string
  aspect_ratio?: string
  error?: string | { code?: string; message?: string } | null
  [key: string]: unknown
}

interface VideoApiError extends Error {
  status?: number
  code?: string | number
  requestId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function unwrapVideoPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const nested = value.data
  return isRecord(nested) ? nested : value
}

function normalizeVideoJob(value: unknown, fallbackId = ''): VideoJob {
  const body = unwrapVideoPayload(value)
  const id = firstString(body.id, body.request_id, body.task_id, fallbackId)
  const status = firstString(body.status) || 'queued'
  if (!id) {
    throw new Error('Video response did not include a task id')
  }
  return { ...body, id, status }
}

async function parseVideoError(response: Response): Promise<VideoApiError> {
  let body: unknown = null
  // Read the body once. A Response body cannot be consumed by json() and
  // text() sequentially, so parse JSON from the text when possible.
  try {
    const rawText = await response.text()
    if (rawText.trim() !== '') {
      try {
        body = JSON.parse(rawText) as unknown
      } catch {
        body = rawText
      }
    }
  } catch {
    // Lightweight test doubles and some non-standard fetch implementations
    // expose json() without text(); keep that fallback for those callers.
    try {
      body = await response.json()
    } catch {
      body = null
    }
  }

  let message = response.statusText || `Video request failed with status ${response.status}`
  let code: string | number | undefined
  if (isRecord(body)) {
    const error = isRecord(body.error) ? body.error : null
    message = firstString(error?.message, body.message, message)
    const rawCode = error?.code ?? body.code
    if (typeof rawCode === 'string' || typeof rawCode === 'number') code = rawCode
  } else if (typeof body === 'string' && body.trim() !== '') {
    message = body.trim()
  }

  const error = new Error(message) as VideoApiError
  error.status = response.status
  error.code = code
  const headers = response.headers
  error.requestId = headers?.get('X-Request-Id') || headers?.get('x-request-id') || undefined
  return error
}

function authHeaders(apiKey: string, extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

export async function createVideo(
  apiKey: string,
  payload: CreateVideoRequest,
  idempotencyKey: string,
): Promise<VideoJob> {
  const response = await fetch(buildGatewayUrl('/v1/videos'), {
    method: 'POST',
    headers: authHeaders(apiKey, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    }),
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await parseVideoError(response)
  return normalizeVideoJob(await response.json())
}

export async function getVideo(apiKey: string, videoId: string): Promise<VideoJob> {
  const response = await fetch(buildGatewayUrl(`/v1/videos/${encodeURIComponent(videoId)}`), {
    method: 'GET',
    headers: authHeaders(apiKey, { Accept: 'application/json' }),
    cache: 'no-store',
  })
  if (!response.ok) throw await parseVideoError(response)
  return normalizeVideoJob(await response.json(), videoId)
}

export async function getVideoContent(apiKey: string, videoId: string): Promise<Blob> {
  const response = await fetch(buildGatewayUrl(`/v1/videos/${encodeURIComponent(videoId)}/content`), {
    method: 'GET',
    headers: authHeaders(apiKey),
    cache: 'no-store',
  })
  if (!response.ok) throw await parseVideoError(response)
  return response.blob()
}
