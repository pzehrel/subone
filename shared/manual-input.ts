export const MANUAL_CONTENT_LIMIT = 1_048_576;
export const MANUAL_CONTENT_SIZE_ERROR = '订阅原文不能超过 1 MiB（1,048,576 字节）';

/** Validate original file bytes before decoding; preserve BOM in the saved text. */
export function decodeManualFile(bytes: Uint8Array): { content: string; error?: never } | { content?: never; error: string } {
  if (bytes.byteLength > MANUAL_CONTENT_LIMIT) return { error: MANUAL_CONTENT_SIZE_ERROR };
  const hex = Array.from(bytes.subarray(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
  if (['504b0304', '504b0506', '504b0708', '1f8b', '425a68', 'fd377a585a00', '377abcaf271c', '526172211a07'].some(signature => hex.startsWith(signature)) || String.fromCharCode(...bytes.subarray(257, 262)) === 'ustar') {
    return { error: '不支持压缩包，请选择 UTF-8 文本文件' };
  }
  try {
    return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch { return { error: '文件必须使用 UTF-8 编码' }; }
}
