import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVideo, getVideo, getVideoContent } from '@/api/video'

describe('video API', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('creates one standard video job with the idempotency key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'task-1', status: 'queued' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createVideo('sk-video', {
      prompt: 'waves',
      model: 'jimeng-2.5-s',
      seconds: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
    }, 'idem-1')).resolves.toMatchObject({ id: 'task-1', status: 'queued' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe(`${window.location.origin}/v1/videos`)
    expect(options.method).toBe('POST')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer sk-video',
      'Idempotency-Key': 'idem-1',
    })
    expect(JSON.parse(options.body)).toEqual({
      prompt: 'waves',
      model: 'jimeng-2.5-s',
      seconds: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
    })
  })

  it('normalizes request ids and polls with GET only', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ task_id: 'task-2', status: 'completed' }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['video'], { type: 'video/mp4' }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getVideo('sk-video', 'task-2')).resolves.toMatchObject({ id: 'task-2', status: 'completed' })
    await expect(getVideoContent('sk-video', 'task-2')).resolves.toBeInstanceOf(Blob)

    expect(fetchMock.mock.calls[0][0]).toBe(`${window.location.origin}/v1/videos/task-2`)
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')
    expect(fetchMock.mock.calls[1][0]).toBe(`${window.location.origin}/v1/videos/task-2/content`)
    expect(fetchMock.mock.calls[1][1].method).toBe('GET')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('download'))
  })

  it('reports gateway errors without exposing request credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers(),
      json: async () => ({ error: { message: 'invalid duration', code: 'invalid_request' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getVideo('sk-video', 'task-3')).rejects.toThrow('invalid duration')
    expect(fetchMock.mock.calls[0][0]).not.toContain('sk-video')
  })

  it('preserves a plain-text gateway error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
      text: async () => 'upstream video service unavailable',
    }))

    await expect(getVideo('sk-video', 'task-4')).rejects.toThrow('upstream video service unavailable')
  })
})
