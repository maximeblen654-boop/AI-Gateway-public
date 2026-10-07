'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const revisionPattern = /^[A-Za-z0-9._-]{1,128}$/;

class JournalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'JournalError';
    this.code = code;
  }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new JournalError(code); };
const validId = value => typeof value === 'string' && idPattern.test(value);

function durableWrite(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function removeOwnTemp(directory) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

function createOperationJournal({ rootDir }) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('rootDir is required');
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_journal_directory');

  function operationId(ownerId, clientKey) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !validId(clientKey)) fail('invalid_operation_identity');
    return `op_${hash(`${ownerId}\0${clientKey}`)}`;
  }

  function operationPath(id) {
    if (typeof id !== 'string' || !/^op_[a-f0-9]{64}$/.test(id)) fail('invalid_operation_id');
    return path.join(root, id);
  }

  function readMeta(id) {
    const directory = operationPath(id);
    if (!fs.existsSync(directory)) return null;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(directory, 'intent.json'), 'utf8')); }
    catch { fail('requires_attention'); }
    if (![1,2].includes(meta.version) || meta.operationId !== id || !Array.isArray(meta.children)) fail('requires_attention');
    if (meta.version === 2) {
      const expected = hash(JSON.stringify({ownerId:meta.ownerId,quoteId:meta.quoteId,capabilityRevision:meta.capabilityRevision,currency:meta.currency,children:meta.children}));
      if (expected !== meta.fingerprint || meta.children.some(c => !c.account || c.keySlotId !== undefined)) fail('requires_attention');
    } else if (meta.children.some(c => c.account !== undefined)) fail('requires_attention');
    return meta;
  }

  function readState(meta) {
    const states = meta.children.map(() => ({ status: 'intent', holdReceiptId: null, taskId: null, reason: null }));
    const filename = path.join(operationPath(meta.operationId), 'events.ndjson');
    if (!fs.existsSync(filename)) return states;
    const raw = fs.readFileSync(filename, 'utf8');
    if (raw && !raw.endsWith('\n')) fail('requires_attention');
    for (const line of raw.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { fail('requires_attention'); }
      const state = states[event.childIndex];
      if (!state || event.version !== 1) fail('requires_attention');
      if (event.type === 'held' && state.status === 'intent' && validId(event.holdReceiptId)) {
        state.status = 'held'; state.holdReceiptId = event.holdReceiptId;
      } else if (event.type === 'dispatching' && (state.status === 'held' || meta.version === 2 && state.status === 'intent')) {
        state.status = 'dispatching';
      } else if (event.type === 'accepted' && state.status === 'dispatching' && validId(event.taskId)) {
        state.status = 'accepted'; state.taskId = event.taskId;
      } else if (event.type === 'rejected' && state.status === 'dispatching' && validId(event.reason)) {
        state.status = 'rejected'; state.reason = event.reason;
      } else if (event.type === 'aborted' && state.status === 'intent' && validId(event.reason)) {
        state.status = 'aborted'; state.reason = event.reason;
      } else fail('requires_attention');
    }
    // Local user cancellation follows a native RELEASED ledger receipt. It
    // preserves the upstream history and never claims supplier rejection.
    states.forEach((state, index) => {
      const filename = path.join(operationPath(meta.operationId), `user-cancellation-${index}.json`);
      if (!fs.existsSync(filename)) return;
      let value;
      try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('requires_attention'); }
      const child = meta.children[index];
      if (!['held', 'dispatching'].includes(state.status) || value.version !== 1 ||
          value.kind !== 'user_authorized_cancellation' || value.ownerId !== meta.ownerId ||
          value.childId !== child.childId || value.requestSha256 !== child.bodySha256 ||
          value.releasedAmountMinor !== child.holdAmountMinor || value.ledgerState !== 'RELEASED' ||
          value.reason !== 'user_authorized_cancellation_site_bears_upstream_cost' ||
          !/^[a-f0-9]{64}$/.test(value.finalFingerprint || '') ||
          !/^[a-f0-9]{64}$/.test(value.evidenceSha256 || '') ||
          !Number.isFinite(Date.parse(value.cancelledAt))) fail('requires_attention');
      const parts = [child.childId, String(meta.ownerId), value.reason, value.evidenceSha256];
      if (value.finalFingerprint !== hash(parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join(''))) fail('requires_attention');
      state.status = 'user_cancelled'; state.reason = value.reason;
    });
    // A separate sidecar keeps the historical event format readable by rollback versions.
    states.forEach((state, index) => {
      if (state.status !== 'dispatching') return;
      const filename = path.join(operationPath(meta.operationId), `recovery-${index}.json`);
      if (!fs.existsSync(filename)) return;
      let value;
      try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('requires_attention'); }
      if (value.version !== 1 || value.childId !== meta.children[index].childId ||
          !Number.isSafeInteger(value.notBefore) || value.notBefore < 0) fail('requires_attention');
      state.recoveryNotBefore = value.notBefore;
    });
    return states;
  }

  function getForOwner(ownerId, id) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) fail('invalid_operation_identity');
    const meta = readMeta(id);
    if (!meta || meta.ownerId !== ownerId) return null;
    const states = readState(meta);
    return { ...meta, children: meta.children.map((child, index) => ({ ...child, ...states[index] })) };
  }

  function getByClientKey(ownerId, clientKey) {
    return getForOwner(ownerId, operationId(ownerId, clientKey));
  }

  function listForOwner(ownerId, limit = 50) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) fail('invalid_operation_identity');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_list_limit');
    const ids = fs.readdirSync(root).filter(name => /^op_[a-f0-9]{64}$/.test(name));
    if (ids.length > 10000) fail('requires_attention');
    const owned = [];
    for (const id of ids) {
      const directory = operationPath(id);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('requires_attention');
      const operation = getForOwner(ownerId, id);
      if (operation) owned.push(operation);
    }
    owned.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') ||
      b.operationId.localeCompare(a.operationId));
    return { items: owned.slice(0, limit), hasMore: owned.length > limit };
  }

  function listPending(limit = 20, offset = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0) fail('invalid_list_limit');
    const ids = fs.readdirSync(root).filter(name => /^op_[a-f0-9]{64}$/.test(name));
    if (ids.length > 10000) fail('requires_attention');
    const pending = [];
    for (const id of ids) {
      const meta = readMeta(id);
      const operation = getForOwner(meta.ownerId, id);
      operation.children.forEach((child, index) => {
        if (['intent', 'held', 'dispatching', 'accepted', 'rejected'].includes(child.status)) {
          pending.push({ ownerId: meta.ownerId, operationId: id, index, status: child.status,
            createdAt: meta.createdAt });
        }
      });
    }
    pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return pending.slice(offset, offset + limit);
  }

  function createIntent({ ownerId, clientKey, quoteId, capabilityRevision, currency, children }) {
    const id = operationId(ownerId, clientKey);
    if (!validId(quoteId) || typeof capabilityRevision !== 'string' || !revisionPattern.test(capabilityRevision)
      || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)
      || !Array.isArray(children) || children.length < 1 || children.length > 100) fail('invalid_intent');
    const bodies = [];
    const childMeta = children.map((child, index) => {
      if (!child || (!child.account && (!validId(child.keySlotId) || !Number.isSafeInteger(child.holdAmountMinor) || child.holdAmountMinor <= 0)) || (child.account && child.keySlotId !== undefined) || !(child.bodyBytes instanceof Uint8Array)
        || child.bodyBytes.byteLength < 2 || child.bodyBytes.byteLength > MAX_BODY_BYTES) fail('invalid_intent');
      const supplierCostEstimate = child.supplierCostEstimate;
      if (supplierCostEstimate && (!Number.isSafeInteger(supplierCostEstimate.creditsHundredths) ||
        supplierCostEstimate.creditsHundredths <= 0 ||
        !revisionPattern.test(supplierCostEstimate.sourceRevision) ||
        Number.isNaN(Date.parse(supplierCostEstimate.observedAt)))) fail('invalid_intent');
      const body = Buffer.from(child.bodyBytes);
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_intent');
      } catch { fail('invalid_intent'); }
      bodies.push(body);
      const childId = child.account ? `av_${hash(`${id}:${index}`)}` : `${id}_c${index}`;
      if (child.account && (child.account.binding?.version !== 'account_video_v1' ||
          child.account.binding.owner?.user_id !== ownerId || child.account.binding.request_hash !== hash(body) ||
          !/^[a-f0-9]{64}$/.test(child.account.binding_hash || '') || !/^[a-f0-9]{64}$/.test(child.account.quote_token || '') ||
          child.account.binding.quote_id !== quoteId || !Number.isSafeInteger(child.account.key_ref) || child.account.key_ref <= 0)) fail('invalid_account_binding');
      return {
        childId,
        upstreamIdempotencyKey: childId,
        ...(child.account ? {account:JSON.parse(JSON.stringify(child.account))} : {keySlotId:child.keySlotId,holdAmountMinor:child.holdAmountMinor}),
        ...(supplierCostEstimate ? { supplierCostEstimate } : {}),
        bodySha256: hash(body),
        bodyFile: `body-${index}.bin`,
      };
    });
    if (childMeta.some(c=>Boolean(c.account)!==Boolean(childMeta[0].account))) fail('mixed_identity_modes');
    const version = childMeta[0].account ? 2 : 1;
    const fingerprint = hash(JSON.stringify({ ownerId, quoteId, capabilityRevision, currency, children: childMeta }));
    const existing = readMeta(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('idempotency_conflict');
      return getForOwner(ownerId, id);
    }
    const temp = path.join(root, `.pending-${randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    try {
      for (let index = 0; index < bodies.length; index++) durableWrite(path.join(temp, `body-${index}.bin`), bodies[index]);
      durableWrite(path.join(temp, 'intent.json'), Buffer.from(JSON.stringify({
        version, operationId: id, ownerId, quoteId, capabilityRevision, currency,
        createdAt: new Date().toISOString(),
        fingerprint, children: childMeta,
      })));
      try { syncDirectory(temp); fs.renameSync(temp, operationPath(id)); syncDirectory(root); }
      catch (error) {
        if (!fs.existsSync(operationPath(id))) throw error;
        const winner = readMeta(id);
        if (winner.fingerprint !== fingerprint) fail('idempotency_conflict');
      }
    } finally { removeOwnTemp(temp); }
    return getForOwner(ownerId, id);
  }

  function appendEvent(meta, event) {
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, ...event })}\n`);
    if (bytes.length > 1024) fail('invalid_event');
    const fd = fs.openSync(path.join(operationPath(meta.operationId), 'events.ndjson'), 'a', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(operationPath(meta.operationId));
  }

  function transition(ownerId, id, childIndex, type, value) {
    const operation = getForOwner(ownerId, id);
    if (!operation) fail('operation_not_found');
    if (!Number.isSafeInteger(childIndex) || childIndex < 0 || childIndex >= operation.children.length) fail('invalid_child');
    const child = operation.children[childIndex];
    const requirements = { held: 'intent', dispatching: operation.version === 2 ? 'intent' : 'held', accepted: 'dispatching', rejected: 'dispatching', aborted: 'intent' };
    const field = { held: 'holdReceiptId', accepted: 'taskId', rejected: 'reason', aborted: 'reason' }[type];
    if (!requirements[type] || (field && !validId(value))) fail('invalid_event');
    if (child.status !== requirements[type]) {
      if (child.status === type && (!field || child[field] === value)) return operation;
      fail('invalid_transition');
    }
    appendEvent(operation, { type, childIndex, ...(field ? { [field]: value } : {}) });
    return getForOwner(ownerId, id);
  }

  function readChildBody(ownerId, id, childIndex) {
    const operation = getForOwner(ownerId, id);
    if (!operation) fail('operation_not_found');
    const child = operation.children[childIndex];
    if (!child) fail('invalid_child');
    let body;
    try { body = fs.readFileSync(path.join(operationPath(id), child.bodyFile)); }
    catch { fail('requires_attention'); }
    if (hash(body) !== child.bodySha256) fail('requires_attention');
    return body;
  }

  function deferRecovery(ownerId, id, childIndex, notBefore) {
    const operation = getForOwner(ownerId, id);
    const child = operation?.children[childIndex];
    if (!Number.isSafeInteger(childIndex) || childIndex < 0 || !child ||
        child.status !== 'dispatching' || !Number.isSafeInteger(notBefore) || notBefore < 0) fail('invalid_event');
    if (notBefore <= (child.recoveryNotBefore || 0)) return operation;
    const directory = operationPath(id);
    const temporary = path.join(directory, `.recovery-${childIndex}-${randomUUID()}`);
    try {
      durableWrite(temporary, Buffer.from(JSON.stringify({ version: 1, childId: child.childId, notBefore })));
      fs.renameSync(temporary, path.join(directory, `recovery-${childIndex}.json`));
      // Flush the directory entry on POSIX. Windows does not support opening directories.
      if (process.platform !== 'win32') {
        const fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return getForOwner(ownerId, id);
  }

  function recoveryPlan(ownerId, id) {
    const operation = getForOwner(ownerId, id);
    if (!operation) fail('operation_not_found');
    const next = { intent: 'reserve_hold', held: 'submit_once', dispatching: 'recover_read_only',
      accepted: 'poll_original_task', rejected: 'reconcile_release', aborted: 'none', user_cancelled: 'none' };
    return operation.children.map(child => ({ childId: child.childId, action: next[child.status],
      upstreamIdempotencyKey: child.upstreamIdempotencyKey, taskId: child.taskId }));
  }

  async function withChildLock(ownerId, id, childIndex, action) {
    if (typeof action !== 'function') throw new TypeError('Lock action is required');
    const operation = getForOwner(ownerId, id);
    if (!operation) fail('operation_not_found');
    if (!Number.isSafeInteger(childIndex) || childIndex < 0 ||
        childIndex >= operation.children.length) fail('invalid_child');
    const filename = path.join(operationPath(id), `child-${childIndex}.lock`);
    let fd;
    try { fd = fs.openSync(filename, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') fail('operation_locked_requires_attention');
      throw error;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid,
        createdAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
      return await action();
    } finally {
      try { fs.closeSync(fd); }
      finally { fs.unlinkSync(filename); }
    }
  }

  return {
    createIntent, getForOwner, getByClientKey, listForOwner, listPending, readChildBody, recoveryPlan,
    withChildLock, deferRecovery,
    markHeld: (ownerId, id, index, receiptId) => transition(ownerId, id, index, 'held', receiptId),
    markDispatching: (ownerId, id, index) => transition(ownerId, id, index, 'dispatching'),
    markAccepted: (ownerId, id, index, taskId) => transition(ownerId, id, index, 'accepted', taskId),
    markRejected: (ownerId, id, index, reason) => transition(ownerId, id, index, 'rejected', reason),
    markAborted: (ownerId, id, index, reason) => transition(ownerId, id, index, 'aborted', reason),
  };
}

module.exports = { createOperationJournal, JournalError };
