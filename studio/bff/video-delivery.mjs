const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = code => { throw new Error(code); };

// Wrap the existing operation coordinator without changing its journal, submit
// contract, quotes, or native customer ledger. Only successful settlement gains
// a durable original prerequisite. A restart can settle from that same result.
export function createVideoDelivery({ coordinator, journal, ledger, supplier, resultStore } = {}) {
  if (!coordinator || typeof journal?.getForOwner !== 'function' ||
      typeof ledger?.capture !== 'function' || typeof ledger?.getSettlement !== 'function' ||
      typeof supplier?.getTask !== 'function' || typeof supplier?.downloadOriginal !== 'function' ||
      typeof resultStore?.load !== 'function' || typeof resultStore?.put !== 'function') {
    throw new TypeError('Video delivery requires trusted existing adapters and private result storage');
  }
  const inflight = new Map();
  function once(key, action) {
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(action);
    inflight.set(key, pending);
    pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); }).catch(() => {});
    return pending;
  }
  function context(ownerId, operationId, index) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !id(operationId) ||
        !Number.isSafeInteger(index) || index < 0 || index > 99) fail('invalid_original_request');
    const operation = journal.getForOwner(ownerId, operationId);
    if (!operation) fail('operation_not_found');
    const child = operation.children[index];
    if (!child || !['accepted', 'rejected'].includes(child.status)) fail('task_unavailable');
    const binding = child.account?.binding;
    const identity = binding ? { mode:'account_video_v1', ownerId, childId:child.childId, taskId:child.taskId,
      accountId:binding.offer.account_id, bindingHash:child.account.binding_hash, requestHash:child.bodySha256 }
      : {ownerId,childId:child.childId,taskId:child.taskId,keySlotId:child.keySlotId,requestHash:child.bodySha256};
    return {child,identity};
  }
  async function original(identity) {
    const cached = resultStore.load(identity);
    if (cached) return cached;
    const opened = await supplier.downloadOriginal(identity.mode === 'account_video_v1'
      ? {identity,taskId:identity.taskId,method:'GET'}
      : {keySlotId:identity.keySlotId,taskId:identity.taskId,method:'GET'});
    const response = opened?.response;
    const mimeType = response?.headers?.get('content-type')?.toLowerCase();
    const rawLength = response?.headers?.get('content-length');
    const length = Number(rawLength);
    if (opened?.status !== 200 || response?.status !== 200 ||
        !['video/mp4', 'video/webm'].includes(mimeType) ||
        response.headers.get('x-video-quality')?.toLowerCase() !== 'original' ||
        response.headers.has('content-range') || !/^[1-9]\d*$/.test(rawLength || '') ||
        !Number.isSafeInteger(length) || length > resultStore.maxResultBytes || !response.body) {
      await response?.body?.cancel().catch(() => {});
      fail('original_receipt_mismatch');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > length) fail('original_length_mismatch');
        chunks.push(Buffer.from(value));
      }
      if (received !== length) fail('original_length_mismatch');
      return resultStore.put(identity, { bytes: Buffer.concat(chunks, received), mimeType });
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  async function reconcileChild(ownerId, operationId, index) {
    // This stage does not mutate dispatch events. An immutable result commit
    // and native idempotent capture tolerate a process dying between them;
    // adding a durable dispatch lock here would strand that safe recovery.
    return once(`${ownerId}:${operationId}:${index}`, async () => {
      const { child, identity } = context(ownerId, operationId, index);
      if (child.status === 'rejected') return coordinator.reconcileChild(ownerId, operationId, index);
      const settled = await ledger.getSettlement({ ownerId, childId: child.childId });
      if (!settled || settled.ownerId !== ownerId || settled.childId !== child.childId) fail('settlement_receipt_mismatch');
      if (settled.status === 'released') fail('download_not_ready');
      if (settled.status === 'captured') return settled;
      if (settled.status !== 'held') fail('settlement_receipt_mismatch');
      let stored = resultStore.load(identity);
      if (!stored) {
        const task = await supplier.getTask(child.account ? {identity,taskId:child.taskId} : {keySlotId:child.keySlotId,taskId:child.taskId});
        if ((task?.task_id ?? task?.id) !== child.taskId ||
            (task.id && task.task_id && task.id !== task.task_id)) fail('task_receipt_mismatch');
        if (task.status === 'failed') return ledger.release({ ownerId, childId: child.childId,
          evidence: { ownerId, childId: child.childId, requestHash: child.bodySha256,
            status: 'failed', supplierTaskId: child.taskId, reason: 'supplier_failed' } });
        if (task.status !== 'completed') fail('terminal_evidence_unknown');
        stored = await original(identity);
      }
      // Stored full bytes were hashed and decoded before this evidence becomes
      // authoritative. Native capture remains the idempotent money boundary.
      return ledger.capture({ ownerId, childId: child.childId,
        evidence: { ownerId, childId: child.childId, requestHash: child.bodySha256,
          status: 'completed', supplierTaskId: child.taskId, reason: '',
          ...(child.account ? {resultHash:stored.sha256,bindingHash:child.account.binding_hash} : {}) } });
    });
  }
  async function openOriginal(ownerId, operationId, index, { method = 'GET', range } = {}) {
    if (!['GET', 'HEAD'].includes(method) || (range !== undefined &&
        (typeof range !== 'string' || !/^bytes=(0|[1-9]\d*)-\d*$/.test(range)))) fail('invalid_original_request');
    const { child, identity } = context(ownerId, operationId, index);
    if (child.status !== 'accepted') fail('task_unavailable');
    const settled = await ledger.getSettlement({ ownerId, childId: child.childId });
    if (!settled || settled.ownerId !== ownerId || settled.childId !== child.childId || settled.status !== 'captured') fail('download_not_ready');
    // Older captured orders may import their original once, without a new
    // generation or another capture. All subsequent reads use the private copy.
    let stored = resultStore.load(identity);
    if (!stored) {
      stored = await once(`original:${ownerId}:${operationId}:${index}`, async () => {
        const task = await supplier.getTask(child.account ? {identity,taskId:child.taskId} : {keySlotId:child.keySlotId,taskId:child.taskId});
        if ((task?.task_id ?? task?.id) !== child.taskId ||
            (task.id && task.task_id && task.id !== task.task_id) || task.status !== 'completed') fail('download_not_ready');
        return original(identity);
      });
    }
    let status = 200, bytes = stored.bytes;
    const headers = { 'Content-Type': stored.mimeType, 'X-Video-Quality': 'original' };
    if (range !== undefined) {
      const [, rawStart, rawEnd] = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(rawStart), requestedEnd = rawEnd ? Number(rawEnd) : stored.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= stored.size || requestedEnd < start) fail('invalid_content_range');
      const end = Math.min(requestedEnd, stored.size - 1);
      bytes = bytes.subarray(start, end + 1);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stored.size}`;
    }
    headers['Content-Length'] = String(bytes.length);
    return { status, response: new Response(method === 'HEAD' ? null : bytes, { status, headers }) };
  }
  async function inspectTask(ownerId, operationId, index) {
    const { child, identity } = context(ownerId, operationId, index);
    if (child.status === 'accepted' && resultStore.load(identity)) {
      return { childId: child.childId, taskId: child.taskId, status: 'completed', progress: 100,
        billingAction: 'reconcile_authoritative_ledger' };
    }
    return coordinator.inspectTask(ownerId, operationId, index);
  }
  return Object.freeze({ operation: Object.freeze({ ...coordinator, reconcileChild, inspectTask }), openOriginal });
}
