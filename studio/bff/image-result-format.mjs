// Signature identification is deliberately separate from full decoding in the
// result store. Callers may use it only on bytes that the store has validated.
export const IMAGE_FORMATS = Object.freeze({
  png: Object.freeze({ mime_type: 'image/png', output_format: 'png', extension: 'png' }),
  jpeg: Object.freeze({ mime_type: 'image/jpeg', output_format: 'jpeg', extension: 'jpg' }),
  webp: Object.freeze({ mime_type: 'image/webp', output_format: 'webp', extension: 'webp' }),
});

export function imageResultFormat(data, declared = {}) {
  const declaration = value => {
    if (value == null) return null;
    if (typeof value !== 'string') throw new TypeError('Image format metadata mismatch');
    return value.trim().toLowerCase();
  };
  const mime = declaration(declared.mime_type), output = declaration(declared.output_format);
  let format;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) format = IMAGE_FORMATS.png;
  else if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) format = IMAGE_FORMATS.jpeg;
  else if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') format = IMAGE_FORMATS.webp;
  if (!format) throw new TypeError('Invalid image format');
  if ((mime !== null && mime !== format.mime_type) ||
      (output !== null && output !== format.output_format &&
        !(output === 'jpg' && format.output_format === 'jpeg'))) throw new TypeError('Image format metadata mismatch');
  return format;
}
