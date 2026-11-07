const CONTENT_LIMIT = 1_048_576;
const sizeError = '订阅原文不能超过 1 MiB（1,048,576 字节）';

/** File bytes stay intact until size and UTF-8 validation have both succeeded. */
export function readManualInput(body: Record<string, any>, required = false): { content?: string; error?: string } {
  if (body.contentFile !== undefined) {
    if (body.content !== undefined) return { error: '请只提供粘贴原文或一个文件' };
    const file = body.contentFile;
    if (!file || Array.isArray(file) || typeof file !== 'object' || typeof file.name !== 'string' || !file.name || /[/\\]/.test(file.name) || typeof file.base64 !== 'string') {
      return { error: '请选择单个 UTF-8 文本文件，不支持文件夹' };
    }
    // Check the encoded length before allocating the decoded buffer. JSON wrapping
    // is excluded from the content limit; the application request cap still applies.
    if (file.base64.length > 4 * Math.ceil(CONTENT_LIMIT / 3)) return { error: sizeError };
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) return { error: '文件内容传输无效，请重新选择文件' };
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length > CONTENT_LIMIT) return { error: sizeError };
    if (bytes.toString('base64') !== file.base64) return { error: '文件内容传输无效，请重新选择文件' };
    const hex = bytes.subarray(0, 8).toString('hex');
    if (['504b0304', '504b0506', '504b0708', '1f8b', '425a68', 'fd377a585a00', '377abcaf271c', '526172211a07'].some(signature => hex.startsWith(signature)) || bytes.subarray(257, 262).toString() === 'ustar') {
      return { error: '不支持压缩包，请选择 UTF-8 文本文件' };
    }
    try {
      // ignoreBOM preserves U+FEFF as part of the saved original text.
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch { return { error: '文件必须使用 UTF-8 编码' }; }
  }
  if (body.content === undefined) return required ? { error: '请粘贴订阅原文或选择文件' } : {};
  if (typeof body.content !== 'string') return { error: '订阅原文必须是文本' };
  if (Buffer.byteLength(body.content, 'utf8') > CONTENT_LIMIT) return { error: sizeError };
  return { content: body.content };
}
