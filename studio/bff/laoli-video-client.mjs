const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(raw)) throw new Error('VIDEO_SUPPLIER_BASE_URL must use HTTPS');
  return raw.endsWith('/v1') ? raw : `${raw}/v1`;
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function createLaoliVideoClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = normalizeBaseUrl(baseUrl);
  if (typeof apiKey !== 'string' || apiKey.trim().length < 16) throw new Error('VIDEO_SUPPLIER_API_KEY is required');
  const key = apiKey.trim();
  async function request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const response = await fetchImpl(`${root}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      return { response, payload };
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    async submitOnce({ request: payload, idempotencyKey }) {
      const { response, payload: data } = await request('/videos', { method: 'POST', body: payload, idempotencyKey });
      if (!response.ok) throw new Error(`supplier_submit_${response.status}`);
      const taskId = data?.id || data?.task_id || data?.data?.id || data?.data?.task_id;
      if (!safeId(taskId)) throw new Error('supplier_invalid_task');
      return { task_id: taskId, status: data?.status || data?.data?.status || 'queued' };
    },
    async recoverSubmission({ idempotencyKey }) {
      if (!idempotencyKey) return { status: 404, receipt: null };
      const { response, payload: data } = await request(`/video-submissions/current?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
      const taskId = data?.id || data?.task_id || data?.data?.id || data?.data?.task_id;
      return { status: response.status, receipt: safeId(taskId) ? { task_id: taskId, status: data?.status || data?.data?.status || 'queued' } : null };
    },
    async getTask({ taskId }) {
      if (!safeId(taskId)) throw new Error('invalid_task_id');
      const { response, payload: data } = await request(`/videos/${encodeURIComponent(taskId)}`);
      if (!response.ok) throw new Error(`supplier_task_${response.status}`);
      const value = data?.data || data;
      return { task_id: taskId, status: value?.status || 'queued', progress: Number.isSafeInteger(value?.progress) ? value.progress : null, download_url: value?.download_url || value?.output_url || null };
    },
    async downloadOriginal({ taskId, range }) {
      if (!safeId(taskId)) throw new Error('invalid_task_id');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = { Authorization: `Bearer ${key}` };
        if (range) headers.Range = range;
        const response = await fetchImpl(`${root}/videos/${encodeURIComponent(taskId)}/content`, { headers, signal: controller.signal });
        return { status: response.status, response };
      } finally { clearTimeout(timer); }
    },
  });
}
