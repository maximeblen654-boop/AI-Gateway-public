import { buildVideoRequestBytes } from '../api/video-request-builder.mjs';
import { createHash } from 'node:crypto';

// This module has no credentials or HTTP route. Adapters are injected by a trusted server caller.
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function recoveryNotBefore(retryAfter, now) {
  const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  let target;
  if (/^\d+$/.test(value)) target = now + Number(value) * 1000;
  else if (value) target = Date.parse(value);
  return Number.isSafeInteger(target) && target >= now ? target : now + 900000;
}

export function createOperationCoordinator({ journal, ledger, supplier, now = () => Date.now() }) {
  if (!journal || !ledger || !supplier ||
      typeof journal.withChildLock !== 'function' || typeof journal.deferRecovery !== 'function' ||
      typeof now !== 'function' ||
      typeof ledger.reserve !== 'function' ||
      typeof supplier.submitOnce !== 'function' ||
      typeof supplier.recoverSubmission !== 'function') {
    throw new TypeError('Journal, ledger and supplier adapters are required');
  }
  const inflight = new Map();

  function prepare({ ownerId, clientKey, quote, keySlotId, supplierCost, request, count = 1 }) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 ||
        !quote || !safeId(quote.id) || !Number.isSafeInteger(quote.amountMinor) ||
        quote.amountMinor <= 0 || !/^[A-Z]{3}$/.test(quote.currency || '') ||
        typeof quote.capabilityRevision !== 'string' || !safeId(keySlotId) ||
        !Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new TypeError('Invalid server-authoritative operation input');
    }
    const bodyBytes = buildVideoRequestBytes({ ...request, ownerId: String(ownerId) });
    const perChild = Math.floor(quote.amountMinor / count);
    if (perChild <= 0) throw new TypeError('Quote is too small for the requested count');
    const remainder = quote.amountMinor % count;
    if (supplierCost && (!Number.isSafeInteger(supplierCost.supplier_credits_hundredths) ||
        supplierCost.supplier_credits_hundredths <= 0 ||
        supplierCost.supplier_credits_hundredths % count !== 0 ||
        typeof supplierCost.source_revision !== 'string' ||
        typeof supplierCost.observed_at !== 'string')) {
      throw new TypeError('Invalid supplier cost snapshot');
    }
    const children = Array.from({ length: count }, (_, index) => ({
      keySlotId, holdAmountMinor: perChild + (index < remainder ? 1 : 0), bodyBytes,
      ...(supplierCost ? { supplierCostEstimate: {
        creditsHundredths: supplierCost.supplier_credits_hundredths / count,
        sourceRevision: supplierCost.source_revision,
        observedAt: supplierCost.observed_at,
      } } : {}),
    }));
    return journal.createIntent({ ownerId, clientKey, quoteId: quote.id,
      capabilityRevision: quote.capabilityRevision, currency: quote.currency, children });
  }

  async function perform(ownerId, operationId, index) {
    const operation = journal.getForOwner(ownerId, operationId);
    if (!operation) throw new Error('operation_not_found');
    const child = operation.children[index];
    if (!child) throw new Error('invalid_child');

    if (child.status === 'intent') {
      let receipt;
      try {
        receipt = await ledger.reserve({ ownerId, childId: child.childId,
          quoteId: operation.quoteId, currency: operation.currency,
          amountMinor: child.holdAmountMinor, requestHash: child.bodySha256 });
      } catch (error) {
        if (error?.status === 402 && error.message === 'insufficient_balance') {
          journal.markAborted(ownerId, operationId, index, 'insufficient_balance');
        }
        throw error;
      }
      if (!receipt || receipt.ownerId !== ownerId || receipt.childId !== child.childId ||
          receipt.quoteId !== operation.quoteId || receipt.currency !== operation.currency ||
          receipt.amountMinor !== child.holdAmountMinor || receipt.requestHash !== child.bodySha256 ||
          !safeId(receipt.receiptId)) {
        throw new Error('hold_receipt_mismatch');
      }
      journal.markHeld(ownerId, operationId, index, receipt.receiptId);
      return { status: 'held', action: 'submit_once', childId: child.childId };
    }

    if (child.status === 'held') {
      // Body integrity must be checked before the durable dispatch marker.
      const bodyBytes = journal.readChildBody(ownerId, operationId, index);
      journal.markDispatching(ownerId, operationId, index);
      try {
        const receipt = await supplier.submitOnce({ keySlotId: child.keySlotId,
          idempotencyKey: child.upstreamIdempotencyKey, bodyBytes });
        const taskId = receipt?.task_id ?? receipt?.id;
        if (!safeId(taskId) || (receipt.id && receipt.task_id && receipt.id !== receipt.task_id)) {
          throw new Error('submission_receipt_unknown');
        }
        journal.markAccepted(ownerId, operationId, index, taskId);
        return { status: 'accepted', action: 'poll_original_task', childId: child.childId, taskId };
      } catch {
        // The POST may have reached the supplier. Never send it again here.
        return { status: 'dispatching', action: 'recover_read_only', childId: child.childId };
      }
    }

    if (child.status === 'dispatching') {
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < 0) throw new Error('invalid_recovery_clock');
      if ((child.recoveryNotBefore || 0) > instant) {
        return { status: 'dispatching', action: 'recover_read_only', childId: child.childId,
          retryAt: child.recoveryNotBefore };
      }
      // Persist a conservative cooldown before the GET, including crash/network failures.
      journal.deferRecovery(ownerId, operationId, index, instant + 900000);
      const result = await supplier.recoverSubmission({ keySlotId: child.keySlotId,
        idempotencyKey: child.upstreamIdempotencyKey });
      if (result?.status === 200 && result.receipt?.idempotency_key_hash !==
          createHash('sha256').update(child.upstreamIdempotencyKey, 'ascii').digest('hex')) {
        throw new Error('submission_receipt_mismatch');
      }
      if (result?.status === 200 && result.receipt?.receipt === 'accepted') {
        const task = result.receipt.task;
        const taskId = task?.task_id ?? task?.id;
        if (!safeId(taskId) || (task.id && task.task_id && task.id !== task.task_id)) {
          throw new Error('submission_receipt_mismatch');
        }
        journal.markAccepted(ownerId, operationId, index, taskId);
        return { status: 'accepted', action: 'poll_original_task', childId: child.childId, taskId };
      }
      if (result?.status === 200 && result.receipt?.receipt === 'rejected') {
        const rejection = result.receipt.response?.error;
        if (rejection?.submitted !== false || rejection?.retryable !== false) {
          throw new Error('submission_rejection_unconfirmed');
        }
        journal.markRejected(ownerId, operationId, index, 'supplier_rejected');
        return { status: 'rejected', action: 'reconcile_release', childId: child.childId };
      }
      if (result?.status === 202 || result?.status === 404) {
        const receivedAt = now();
        if (!Number.isSafeInteger(receivedAt) || receivedAt < instant) throw new Error('invalid_recovery_clock');
        const retryAt = Math.max(receivedAt + 900000, recoveryNotBefore(result.retryAfter, receivedAt));
        journal.deferRecovery(ownerId, operationId, index, retryAt);
        return { status: 'dispatching', action: 'recover_read_only', childId: child.childId, retryAt };
      }
      throw new Error('submission_receipt_mismatch');
    }
    return { status: child.status, action: journal.recoveryPlan(ownerId, operationId)[index].action,
      childId: child.childId, taskId: child.taskId };
  }

  function advanceChild(ownerId, operationId, index) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !Number.isSafeInteger(index) || index < 0) {
      throw new TypeError('Invalid operation identity');
    }
    const key = `${ownerId}:${operationId}:${index}`;
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(() =>
      journal.withChildLock(ownerId, operationId, index,
        () => perform(ownerId, operationId, index)));
    inflight.set(key, pending);
    pending.finally(() => { if (inflight.get(key) === pending) inflight.delete(key); }).catch(() => {});
    return pending;
  }

  async function inspectTask(ownerId, operationId, index) {
    if (typeof supplier.getTask !== 'function') throw new TypeError('Task reader is required');
    const operation = journal.getForOwner(ownerId, operationId);
    if (!operation) throw new Error('operation_not_found');
    const child = operation.children[index];
    if (!child || child.status !== 'accepted' || !safeId(child.taskId)) {
      throw new Error('task_unavailable');
    }
    const task = await supplier.getTask({ keySlotId: child.keySlotId, taskId: child.taskId });
    const returnedId = task?.task_id ?? task?.id;
    if (returnedId !== child.taskId ||
        (task.id && task.task_id && task.id !== task.task_id) ||
        !['queued', 'in_progress', 'completed', 'failed'].includes(task.status)) {
      throw new Error('task_receipt_mismatch');
    }
    return { childId: child.childId, taskId: child.taskId, status: task.status,
      progress: Number.isInteger(task.progress) && task.progress >= 0 && task.progress <= 100
        ? task.progress : null,
      billingAction: ['completed', 'failed'].includes(task.status) ? 'reconcile_authoritative_ledger' : null };
  }

  // Reconcile the customer ledger only after the supplier task reader returns
  // a terminal state. The Go ledger adapter resolves durable evidence again;
  // this method never accepts a browser supplied amount or status.
  async function reconcileChild(ownerId, operationId, index) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !Number.isSafeInteger(index) || index < 0) {
      throw new TypeError('Invalid operation identity');
    }
    const operation = journal.getForOwner(ownerId, operationId);
    const child = operation?.children[index];
    if (!child || !['accepted', 'rejected'].includes(child.status)) {
      throw new Error('task_unavailable');
    }
    if (child.status === 'rejected') {
      return ledger.release({ ownerId, childId: child.childId,
        evidence: { ownerId, childId: child.childId, requestHash: child.bodySha256,
          status: 'not_submitted', reason: child.reason || 'supplier_rejected' } });
    }
    if (!safeId(child.taskId)) throw new Error('task_unavailable');
    const task = await supplier.getTask({ keySlotId: child.keySlotId, taskId: child.taskId });
    const taskId = task?.task_id ?? task?.id;
    if (taskId !== child.taskId || (task.id && task.task_id && task.id !== task.task_id) ||
        !['completed', 'failed'].includes(task.status)) {
      throw new Error('terminal_evidence_unknown');
    }
    const evidence = { ownerId, childId: child.childId, requestHash: child.bodySha256,
      status: task.status, supplierTaskId: child.taskId,
      reason: task.status === 'failed' ? 'supplier_failed' : '' };
    if (task.status === 'completed') return ledger.capture({ ownerId, childId: child.childId, evidence });
    return ledger.release({ ownerId, childId: child.childId, evidence });
  }

  function listOperations(ownerId, limit = 50) {
    const page = journal.listForOwner(ownerId, limit);
    return {
      items: page.items.map(operation => ({
        operationId: operation.operationId,
        createdAt: operation.createdAt || null,
        children: operation.children.map((child, index) => ({
          index, status: child.status, taskId: child.taskId,
        })),
      })),
      hasMore: page.hasMore,
    };
  }

  return Object.freeze({ prepare, advanceChild, inspectTask, reconcileChild, listOperations });
}
