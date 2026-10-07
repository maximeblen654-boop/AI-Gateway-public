import catalog from '../../backend/internal/videoplan/contract.json' with { type: 'json' };
import { createHash } from 'node:crypto';

// Only the BFF's asset lookup may create these receipts, after checking the
// current user owns the stored asset. A browser payload is never a receipt.
const receiptPayloads = new WeakMap();
const allowedInputKeys = new Set(['ownerId', 'model', 'prompt', 'duration', 'resolution', 'ratio', 'assets']);
const mediaTypes = new Set(['image', 'video', 'audio']);
const mimeTypes = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
  audio: new Set(['audio/mpeg', 'audio/mp3', 'audio/x-m4a', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg']),
};
const candidates = new Map(catalog.models.map(model => [model.apiModelId, model]));
if (candidates.size !== catalog.models.length || catalog.revision !== 'laoli-video-api-v1.36-2026-10-02') {
  throw new Error('Video contract catalog mismatch');
}

function fail(reason) { throw new TypeError(reason); }
function keysOnly(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.has(key))) fail(`Invalid ${label}`);
}
function httpsSource(source) {
  if (typeof source !== 'string') fail('Invalid asset source');
  let url;
  try { url = new URL(source); } catch { fail('Invalid asset source'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    fail('Asset source must be HTTPS');
  }
  return source;
}

/** Call only after a server-side asset lookup and current-user ownership check. */
export function makeVerifiedAssetReceipt({ ownerId, type, mimeType, size, bytes, source, durationSeconds } = {}) {
  if (typeof ownerId !== 'string' || !ownerId || !mediaTypes.has(type) ||
      !mimeTypes[type].has(mimeType) || !Number.isSafeInteger(size) || size < 1) {
    fail('Invalid verified asset metadata');
  }
  if ((bytes === undefined) === (source === undefined)) fail('Asset needs exactly one server source');
  if (bytes !== undefined && (!(bytes instanceof Uint8Array) || bytes.byteLength !== size)) {
    fail('Asset bytes do not match verified size');
  }
  if (source !== undefined) httpsSource(source);
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    fail('Invalid asset duration');
  }
  const receipt = Object.freeze({ ownerId, type, mimeType, size, durationSeconds });
  receiptPayloads.set(receipt, bytes === undefined ? { source } : { bytes: Uint8Array.from(bytes) });
  return receipt;
}

function assertAssets(assets, ownerId, model) {
  if (!Array.isArray(assets)) fail('Assets must be an ordered array');
  const counts = { image: 0, video: 0, audio: 0 };
  if (assets.length > model.mediaLimits.total) fail('Too many assets');
  for (const asset of assets) {
    if (!asset || !receiptPayloads.has(asset) || asset.ownerId !== ownerId || !mediaTypes.has(asset.type)) {
      fail('Asset ownership receipt required');
    }
    if (++counts[asset.type] > model.mediaLimits[asset.type]) fail('Too many assets of one type');
  }
  if (model.requiredAnyMedia.length && !model.requiredAnyMedia.some(type => counts[type] > 0)) {
    fail('Required image or video missing');
  }
  if (model.apiModelId.startsWith('happyhorse-') && counts.image === 0) fail('Happyhorse requires image');
  return counts;
}

function assertPromptReferences(prompt, counts) {
  const types = { '图片': 'image', '图': 'image', '视频': 'video', '音频': 'audio' };
  for (const match of prompt.matchAll(/@(图片|图|视频|音频)(\d+)/gu)) {
    const raw = match[2];
    const index = Number(raw);
    if (!Number.isSafeInteger(index) || index < 1 || String(index) !== raw || index > counts[types[match[1]]]) {
      fail('Prompt reference has no matching asset');
    }
  }
}

function inlineMedia(assets, mode) {
  const groups = { image: [], video: [], audio: [] };
  let imageBytes = 0, avBytes = 0;
  for (const asset of assets) {
    const payload = receiptPayloads.get(asset);
    if (!payload.bytes) fail('Inline model requires verified bytes');
    if (mode === 'images' && asset.type !== 'image') fail('Image-only model rejects video and audio');
    if (mode === 'inline_multimedia' || mode === 'images') {
      if (asset.size > 50 * 1024 * 1024) fail('Inline asset exceeds 50 MiB');
      if (asset.type === 'image') imageBytes += asset.size;
      else avBytes += asset.size;
    }
    groups[asset.type].push(`data:${asset.mimeType};base64,${Buffer.from(payload.bytes).toString('base64')}`);
  }
  if (imageBytes > 70 * 1024 * 1024 || avBytes > 60 * 1024 * 1024) {
    fail('Inline aggregate size exceeded');
  }
  return groups;
}

function referenceMedia(assets, model) {
  let officialAudioDuration = 0;
  let minimaxImageBytes = 0;
  const references = assets.map(asset => {
    const payload = receiptPayloads.get(asset);
    if (!payload.source) fail('Reference model requires verified HTTPS source');
    if (model.apiModelId === 'minimax-h3-1080p' && asset.type === 'image') {
      if (asset.size > 5 * 1024 * 1024) fail('MiniMax image exceeds 5 MiB');
      minimaxImageBytes += asset.size;
      if (minimaxImageBytes > 20 * 1024 * 1024) fail('MiniMax images exceed 20 MiB');
    }
    if (model.apiModelId === 'sd-2.5-native-seconds' && asset.size > 25_000_000) {
      fail('Reference asset exceeds 25 MB');
    }
    const reference = { type: asset.type, source: httpsSource(payload.source) };
    if (asset.type !== 'image' && (model.apiModelId.startsWith('sd-official-') ||
        model.apiModelId === 'sd-2.5-native-seconds')) {
      if (asset.durationSeconds === undefined) fail('Media duration receipt required');
      if (model.apiModelId.startsWith('sd-official-')) {
        if (asset.durationSeconds > (asset.type === 'audio' ? 30 : 30.2)) fail('Reference media too long');
        if (asset.type === 'audio') officialAudioDuration += asset.durationSeconds;
      }
      reference.duration_seconds = asset.durationSeconds;
    }
    return reference;
  });
  if (officialAudioDuration > 30.2) fail('Official audio total duration exceeded');
  return references;
}

/** Pure v1.36 POST /v1/videos JSON byte constructor. No network, key, quote or ledger access. */
export function CompilePlan(input) {
  return compile(input, undefined);
}

// Only BFF callers use an authenticated Core catalog profile. The browser route
// cannot supply this argument; Core independently resolves and checks the offer.
export function CompilePublishedPlan(input, profile) {
  if (!profile || profile.apiModelId !== input.model || !catalog.wireProfiles[profile.inputMode]) fail('Invalid Published profile');
  const limits = profile.mediaLimits;
  const model = {...profile, requiredAnyMedia: profile.requiredAnyMedia || [],
    mediaLimits: {image:limits.Image ?? limits.image, video:limits.Video ?? limits.video, audio:limits.Audio ?? limits.audio, total:limits.Total ?? limits.total}};
  return compile(input, model);
}

function compile(input, modelOverride) {
  keysOnly(input, allowedInputKeys, 'video request');
  const { ownerId, model: modelId, prompt, duration, resolution, ratio, assets } = input;
  if (typeof ownerId !== 'string' || !ownerId) fail('Owner ID required');
  const model = modelOverride ?? candidates.get(modelId);
  if (!model || model.documentedStatus !== 'enabled') fail('Unsupported or paused model');
  if (typeof prompt !== 'string' || prompt.length < 1 ||
      [...prompt].length > (model.promptMaxLength || 6000)) fail('Invalid prompt');
  if (!Number.isInteger(duration) || !model.durationSeconds.includes(duration) ||
      !model.resolutions.includes(resolution) || !model.ratios.includes(ratio)) {
    fail('Unsupported model configuration');
  }
  const counts = assertAssets(assets, ownerId, model);
  assertPromptReferences(prompt, counts);
  const inline = model.inputMode !== 'references';
  const wire = catalog.wireProfiles[model.inputMode];
  if (!wire) fail('Unsupported wire profile');
  const body = { model: model.upstreamModelId || modelId, prompt,
    [wire.duration]: duration, resolution, [wire.aspectRatio]: ratio, ...wire.fixed };
  if (inline) {
    const groups = inlineMedia(assets, model.inputMode);
    if (groups.image.length) body[wire.image] = groups.image;
    if (groups.video.length) body[wire.video] = groups.video;
    if (groups.audio.length) body[wire.audio] = groups.audio;
  } else if (assets.length) {
    body[wire.references] = referenceMedia(assets, model);
  }
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.byteLength > 128 * 1024 * 1024) fail('Video JSON exceeds 128 MiB');
  const plan = {
    version: 'video_json_plan_v1', adapterRevision: 'laoli_video_json_v136_r1',
    method: 'POST', path: '/v1/videos', encoding: 'application/json',
    contractRevision: catalog.revision, fields: body,
  };
  const snapshot = JSON.parse(JSON.stringify(plan));
  snapshot.planHash = planHash(snapshot);
  return snapshot;
}

function planHash(plan) {
  const { planHash: ignored, ...content } = plan;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// Uses only persisted plan fields, never the current catalog. The hash detects
// accidental mutation; authorization still belongs to the opaque server quote.
export function Materialize(plan) {
  if (!plan || plan.version !== 'video_json_plan_v1' ||
      plan.adapterRevision !== 'laoli_video_json_v136_r1' ||
      plan.method !== 'POST' || plan.path !== '/v1/videos' ||
      plan.encoding !== 'application/json' || planHash(plan) !== plan.planHash) {
    fail('Unsupported or changed frozen video plan');
  }
  const bytes = Buffer.from(JSON.stringify(plan.fields), 'utf8');
  if (bytes.byteLength > 128 * 1024 * 1024) fail('Video JSON exceeds 128 MiB');
  return { bytes, requestHash: createHash('sha256').update(bytes).digest('hex'),
    method: plan.method, path: plan.path, adapterRevision: plan.adapterRevision };
}

// Legacy callers retain the same validation and bytes; one shared field builder.
export function buildVideoRequestBytes(input) {
  return Materialize(CompilePlan(input)).bytes;
}
