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
    const stored = requested.map(ref => {
      const a = intake.uploadPayload(session.ownerId, ref.asset_ref);
      if (a.kind !== ref.kind) throw Error('asset_type_mismatch');
      return { asset_ref: ref.asset_ref, kind: a.kind, mime_type: a.mimeType, size: a.size,
        sha256: a.sha256, ...(a.durationSeconds ? { duration_seconds: a.durationSeconds } : {}), bytes_base64: Buffer.from(a.bytes).toString('base64') };
    });
    const fullSpec = { resolution: spec.resolution, duration_seconds: spec.duration_seconds,
      aspect_ratio: spec.aspect_ratio, quality: '', count: 1,
      images: stored.filter(a => a.kind === 'image').length, videos: stored.filter(a => a.kind === 'video').length, audio: stored.filter(a => a.kind === 'audio').length };
    if (model.inputMode !== 'references') {
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
      compile({ownerId: String(session.ownerId), model: modelId, prompt: 'Reference preparation', duration: spec.duration_seconds,
        resolution: spec.resolution, ratio: spec.aspect_ratio, assets: stored.map(a => makeVerifiedAssetReceipt({ownerId:String(session.ownerId),type:a.kind,mimeType:a.mime_type,size:a.size,source:'https://prepare.invalid/asset',durationSeconds:a.duration_seconds}))});
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
      return makeVerifiedAssetReceipt({ownerId:String(session.ownerId),type:r.kind,mimeType:r.mime_type,size:r.size,source:r.source,durationSeconds:r.duration_seconds});
    }) };
  };
}
