// The 2026-10-25 Seedance failure established a stricter input requirement
// than the generic Agnes documentation. Bind it to the resolved protocol,
// never a customer alias, and leave other protocols unchanged.
export function referenceImageMinSide(offer) {
  const profile = offer?.video_profile;
  return profile?.inputMode === 'image2pro' && profile.image2pro?.protocol === 'seedance2-video' ? 300 : 0;
}

export function withVideoReferenceRules(payload) {
  if (!Array.isArray(payload?.offers)) return payload;
  return { ...payload, offers: payload.offers.map(offer => {
    const min = referenceImageMinSide(offer);
    return min ? { ...offer, reference_image_min_side: min } : offer;
  }) };
}
