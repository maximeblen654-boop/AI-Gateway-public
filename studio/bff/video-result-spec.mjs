const fail = code => { throw new Error(code); };
const pair = (value, separator) => {
  const parts = typeof value === 'string' ? value.split(separator) : [];
  return parts.length === 2 && parts.every(p => /^[1-9]\d{0,4}$/.test(p) && Number(p) <= 8192)
    ? parts.map(Number) : undefined;
};

// Only unambiguous pixel specifications are interpreted here. The supplier's
// existing contract enumerates labels (720p, 4k, ...) but does not define their
// pixel grids/rounding for every ratio. Never invent a short-side convention.
export function videoResultExpectation(spec) {
  if (spec?.count !== 1 || !Number.isSafeInteger(spec.duration_seconds) || !Number.isSafeInteger(spec.duration_seconds * 1_000_000) || spec.duration_seconds <= 0) fail('video_result_spec_invalid');
  const size = pair(spec.resolution, 'x');
  if (!size) fail('video_result_resolution_unverifiable');
  const ratio = pair(spec.aspect_ratio, ':');
  if (!ratio) fail('video_result_aspect_unverifiable');
  if (size[0] * ratio[1] !== size[1] * ratio[0]) fail('video_result_spec_invalid');
  return {width:size[0],height:size[1],ratio,durationMicros:spec.duration_seconds * 1_000_000};
}

export function assertVideoResultSpec(media, spec) {
  const expected = videoResultExpectation(spec);
  if (media?.version !== 1 || !Number.isSafeInteger(media.width) || media.width <= 0 ||
      !Number.isSafeInteger(media.height) || media.height <= 0 || !Number.isSafeInteger(media.frames) || media.frames < 1 ||
      !Number.isSafeInteger(media.durationMicros) || media.durationMicros <= 0) fail('video_result_metadata_missing');
  if (media.width * expected.ratio[1] !== media.height * expected.ratio[0]) fail('video_result_aspect_mismatch');
  if (media.width !== expected.width || media.height !== expected.height) fail('video_result_dimensions_mismatch');
  // At most two microseconds of endpoint serialization/rounding; this is not a
  // supplier duration allowance (no arbitrary percentage or one-frame grace).
  if (Math.abs(media.durationMicros - expected.durationMicros) > 2) fail('video_result_duration_mismatch');
}

export function decodedVideoMeasurement(probe, framesDecoded) {
  const videos = probe.streams?.filter(s => s.codec_type === 'video') || [];
  const frames = probe.frames?.filter(f => f.media_type === 'video') || [];
  if (videos.length !== 1 || !frames.length || frames.length !== framesDecoded) return null;
  const stream = videos[0], first = frames[0];
  if (stream.sample_aspect_ratio !== '1:1' || stream.side_data_list?.some(s => s.rotation && s.rotation % 360 !== 0)) return null;
  let start, end, previous;
  for (const frame of frames) {
    if (frame.width !== stream.width || frame.height !== stream.height || frame.width !== first.width || frame.height !== first.height) return null;
    const time = Number(frame.best_effort_timestamp_time), duration = Number(frame.duration_time ?? frame.pkt_duration_time);
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || previous !== undefined && time <= previous) return null;
    start ??= time;
    end = Math.max(end ?? time, time + duration);
    previous = time;
  }
  return {version:1,width:first.width,height:first.height,frames:frames.length,durationMicros:Math.round((end - start) * 1_000_000)};
}
