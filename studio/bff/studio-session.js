'use strict';

const { randomBytes } = require('node:crypto');

const SESSION_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 4096;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function createCoreStudioClient({ baseUrl, serviceToken, fetchImpl = fetch }) {
  if (typeof serviceToken !== 'string' || serviceToken.length < 32) throw new Error('Studio service token is required');
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Invalid Studio core URL');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Error('Studio core requires HTTPS or loopback HTTP');
  }
  async function call(path, payload) {
    const response = await fetchImpl(new URL(path, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Service-Token': serviceToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (response.status === 401) return null;
    if (!response.ok) throw new Error('Studio core unavailable');
    if (Number(response.headers.get('content-length')) > 8192) throw new Error('Invalid Studio core response');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error('Invalid Studio core response'); }
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid Studio core response'); }
    if (body?.code !== 0 || !Number.isSafeInteger(body.data?.user_id) || body.data.user_id <= 0) {
      throw new Error('Invalid Studio core response');
    }
    return body.data;
  }
  return {
    consume: ticket => call('/api/v1/internal/studio/tickets/consume', { ticket }),
    verify: sessionProof => call('/api/v1/internal/studio/sessions/verify', { session_proof: sessionProof }),
  };
}

function createStudioSessionBridge({ core, secureCookies = false, publicOrigin, now = () => Date.now() }) {
  if (typeof core?.consume !== 'function' || typeof core?.verify !== 'function') throw new Error('Studio core client required');
  if (publicOrigin !== undefined) {
    const parsed = new URL(publicOrigin);
    if (parsed.origin !== publicOrigin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) {
      throw new Error('Invalid Studio public origin');
    }
    if (parsed.protocol === 'https:' && !secureCookies) throw new Error('HTTPS Studio requires secure cookies');
  }
  const sessions = new Map();
  function cookie(request) {
    const matches = (request.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith('studio_session='));
    if (matches.length !== 1) return null;
    const value = matches[0].slice('studio_session='.length);
    return SESSION_PATTERN.test(value) ? value : null;
  }
  function header(value, maxAge) {
    return `studio_session=${value}; Path=/studio; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  }
  function sameOrigin(request) {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return false;
    const scheme = secureCookies ? 'https' : 'http';
    return origin === (publicOrigin || `${scheme}://${request.headers.host}`);
  }
  async function exchange(request, ticket) {
    if (request.headers['x-studio-request'] !== 'session-exchange-v1' || !sameOrigin(request) || !TICKET_PATTERN.test(ticket || '')) return null;
    if (sessions.size >= MAX_SESSIONS) {
      for (const [id, saved] of sessions) if (now() >= saved.expiresAt) sessions.delete(id);
      if (sessions.size >= MAX_SESSIONS) throw new Error('Studio session capacity reached');
    }
    const identity = await core.consume(ticket);
    if (!Number.isSafeInteger(identity?.user_id) || identity.user_id <= 0 || !TICKET_PATTERN.test(identity.session_proof || '')) return null;
    const old = cookie(request);
    if (old) sessions.delete(old);
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { ownerId: identity.user_id, proof: identity.session_proof, expiresAt: now() + SESSION_MAX_AGE_MS });
    return { cookie: header(id, 900), ownerId: identity.user_id };
  }
  async function authenticate(request) {
    const id = cookie(request);
    const saved = id && sessions.get(id);
    if (!saved) return null;
    if (now() >= saved.expiresAt) { sessions.delete(id); return null; }
    const verified = await core.verify(saved.proof);
    if (!verified || verified.user_id !== saved.ownerId) { sessions.delete(id); return null; }
    // Keep the proof server-side for the ledger/supplier orchestration layer.
    // The HTTP handler projects only ownerId and never serializes this value.
    return { ownerId: saved.ownerId, sessionProof: saved.proof };
  }
  function clear(request) {
    const id = cookie(request);
    if (id) sessions.delete(id);
    return header('', 0);
  }
  return { exchange, authenticate, clear, sameOrigin };
}

module.exports = { createCoreStudioClient, createStudioSessionBridge };
