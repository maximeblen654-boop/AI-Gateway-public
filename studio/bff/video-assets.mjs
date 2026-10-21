import { makeVerifiedAssetReceipt, CompilePlan, CompilePublishedPlan } from '../api/video-request-builder.mjs';
import contract from '../../backend/internal/videoplan/contract.json' with { type: 'json' };

// Both fresh and restarted requests use the private store and the same durable
// preparation shape. The browser never supplies a trusted source or receipt.
export function createVideoAssetResolver({ intake, tasks }) {
  return async (session, requested, offerId, modelId, spec, { prepare = false, preparationId } = {}) => {
    if (!intake) throw Error('asset_store_unavailable');
    const payload = await tasks.catalog(session);
    const configured = payload?.offers?.find(o => o.offer_id === offerId && o.model === modelId);
    if (!configured) throw Error('unsupported_model');
    const model = configured.video_profile ?? contract.models.find(m => m.apiModelId === modelId);
    if (!model || model.documentedStatus !== 'enabled') throw Error('unsupported_model');
    const declaredLimits = model.mediaLimits;
    const limits = { image: declaredLimits?.image ?? declaredLimits?.Image,
      video: declaredLimits?.video ?? declaredLimits?.Video,
      audio: declaredLimits?.audio ?? declaredLimits?.Audio,
      total: declaredLimits?.total ?? declaredLimits?.Total };
    if (Object.values(limits).some(value => !Number.isInteger(value) || value < 0 || value > 30)) throw Error('unsupported_model');
    const counts = {image: 0, video: 0, audio: 0};
    if (!Array.isArray(requested) || requested.length > 30 || requested.length > limits.total) throw Error('media_reference_limit_exceeded');
    for (const ref of requested) {
      if (!(ref.kind in counts) || ++counts[ref.kind] > limits[ref.kind]) throw Error('media_reference_limit_exceeded');
    }
    // Bound retained bytes before base64 copies; the existing wire budget is 24 MiB.
    let totalBytes = 0;
    const stored = requested.map(ref => {
      const a = intake.uploadPayload(session.ownerId, ref.asset_ref);
      totalBytes += a.size;
      if (!Number.isSafeInteger(a.size) || a.size < 1 || totalBytes > 18 * 1024 * 1024) throw Error('media_request_too_large');
      if (a.kind !== ref.kind) throw Error('asset_type_mismatch');
      return { asset_ref: ref.asset_ref, kind: a.kind, mime_type: a.mimeType, size: a.size,
        sha256: a.sha256, ...(a.durationSeconds ? { duration_seconds: a.durationSeconds } : {}), bytes_base64: Buffer.from(a.bytes).toString('base64') };
    });
    const fullSpec = { resolution: spec.resolution, duration_seconds: spec.duration_seconds,
      aspect_ratio: spec.aspect_ratio, quality: '', count: 1,
      images: stored.filter(a => a.kind === 'image').length, videos: stored.filter(a => a.kind === 'video').length, audio: stored.filter(a => a.kind === 'audio').length };
    const preparedProfile = model.inputMode === 'references' || model.inputMode === 'image2pro';
    if (!preparedProfile) {
      if (preparationId || prepare) throw Error('account_bound_reference_upload_unavailable');
      return stored.map(a => intake.inlineReceipt(session.ownerId, a.asset_ref));
    }
    // A text-only request has no external upload to bind. An explicitly supplied
    // preparation still has to match; required-media checks remain in the builder.
    if (!stored.length && !prepare && !preparationId) return [];
    if (!prepare && !preparationId) throw Error('account_video_preparation_missing');
    if (prepare) {
      // Compile locally before any network action; Core also validates Published.
      const compile = input => configured.video_profile ? CompilePublishedPlan(input, configured.video_profile) : CompilePlan(input);
      // These inert receipts only validate the shape before a bounded upload.
      // Core independently binds the actual attachment to Account/model/owner.
      const preview = stored.map((a, index) => makeVerifiedAssetReceipt({ownerId:String(session.ownerId),
        type:a.kind,mimeType:a.mime_type,size:a.size,durationSeconds:a.duration_seconds,
        ...(model.inputMode !== 'image2pro' ? {source:'https://prepare.invalid/asset'} :
          a.kind === 'image' ? {bytes:Buffer.from(a.bytes_base64,'base64')} :
          {mediaId:`prepare-preview-${index}`,expiresAt:new Date(Date.now()+60_000).toISOString()})}));
      compile({ownerId: String(session.ownerId), model: modelId, prompt: 'Reference preparation', duration: spec.duration_seconds,
        resolution: spec.resolution, ratio: spec.aspect_ratio, assets: preview});
      const prepared = await tasks.prepareReferences(session, {offer_id:offerId,model:modelId,spec:fullSpec,assets:stored});
      preparationId = prepared.preparation_id;
    }
    const p = tasks.getPreparation(session, preparationId);
    const metadata = stored.map(({bytes_base64, ...a}) => a);
    const sameSpec = p?.spec && Object.keys(fullSpec).every(k => p.spec[k] === fullSpec[k]);
    if (!p || p.owner_id !== session.ownerId || p.offer_id !== offerId || p.model !== modelId || !sameSpec ||
      JSON.stringify(p.assets) !== JSON.stringify(metadata) || p.result?.preparation_id !== preparationId ||
      p.result.receipts?.length !== stored.length) throw Error('account_video_preparation_mismatch');
    return { preparationId, assets: p.result.receipts.map((r, i) => {
      const a = metadata[i];
      if (Object.keys(a).some(k => r[k] !== a[k])) throw Error('account_video_preparation_mismatch');
      if (model.inputMode === 'image2pro') {
        if (r.source || r.upload_id) throw Error('account_video_preparation_mismatch');
        if (a.kind === 'image') {
          if (r.source_kind !== 'inline' || r.media_id) throw Error('account_video_preparation_mismatch');
          return makeVerifiedAssetReceipt({ownerId:String(session.ownerId),type:a.kind,mimeType:a.mime_type,
            size:a.size,bytes:Buffer.from(stored[i].bytes_base64,'base64'),durationSeconds:a.duration_seconds});
        }
        if (r.source_kind !== 'media_id') throw Error('account_video_preparation_mismatch');
        return makeVerifiedAssetReceipt({ownerId:String(session.ownerId),type:a.kind,mimeType:a.mime_type,
          size:a.size,mediaId:r.media_id,expiresAt:r.expires_at,durationSeconds:a.duration_seconds});
      }
      return makeVerifiedAssetReceipt({ownerId:String(session.ownerId),type:r.kind,mimeType:r.mime_type,size:r.size,source:r.source,durationSeconds:r.duration_seconds});
    }) };
  };
}
