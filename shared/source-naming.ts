export const DEFAULT_NAME_TEMPLATE = '{upstream_name}_{region} {region_index}';
export const NAMING_FIELDS = ['upstream_name', 'region', 'region_index', 'region_code', 'region_emoji'] as const;
export type NamingConfiguration = { extractRegex?: string; nameTemplate?: string };
export class NamingValidationError extends Error {
  constructor(public field: 'extractRegex' | 'nameTemplate', message: string) { super(message); }
}

type TemplatePart = { text: string } | { field: string };
export function parseNameTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  const flush = () => { if (text) { parts.push({ text }); text = ''; } };
  for (let index = 0; index < template.length;) {
    const char = template[index];
    if ((char === '{' || char === '}') && template[index + 1] === char) { text += char; index += 2; continue; }
    if (char === '}') throw new NamingValidationError('nameTemplate', '名称模板的括号不完整');
    if (char !== '{') { text += char; index++; continue; }
    flush();
    const end = template.indexOf('}', index + 1);
    if (end < 0) throw new NamingValidationError('nameTemplate', '名称模板的括号不完整');
    const field = template.slice(index + 1, end);
    if (!field || /[{}]/.test(field)) throw new NamingValidationError('nameTemplate', '名称模板的字段无效');
    parts.push({ field }); index = end + 1;
  }
  flush(); return parts;
}

/** Read declarations without treating escaped text or character classes as groups. */
function captureNames(pattern: string): string[] {
  const names: string[] = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '\\') { index++; continue; }
    if (pattern[index] === '[') inClass = true;
    if (pattern[index] === ']') inClass = false;
    if (!inClass && pattern.startsWith('(?<', index) && !['=', '!'].includes(pattern[index + 3])) {
      const end = pattern.indexOf('>', index + 3);
      // JS accepts Unicode escapes in group names; groups exposes the decoded key.
      const rawName = pattern.slice(index + 3, end);
      names.push(rawName.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})/gi, (_match, full, short) => String.fromCodePoint(parseInt(full || short, 16))));
    }
  }
  return names;
}

export function validateSourceNaming(value: NamingConfiguration): void {
  if (value.extractRegex !== undefined && typeof value.extractRegex !== 'string') throw new NamingValidationError('extractRegex', '提取正则必须是文本');
  if (value.nameTemplate !== undefined && typeof value.nameTemplate !== 'string') throw new NamingValidationError('nameTemplate', '名称模板必须是文本');
  const pattern = value.extractRegex ?? '';
  try { new RegExp(pattern, 'i'); } catch { throw new NamingValidationError('extractRegex', '提取正则无效'); }
  const names = captureNames(pattern);
  if (names.some(name => (NAMING_FIELDS as readonly string[]).includes(name))) throw new NamingValidationError('extractRegex', '提取字段不能使用内置字段名');
  const allowed = new Set<string>([...NAMING_FIELDS, ...names]);
  for (const part of parseNameTemplate(value.nameTemplate ?? DEFAULT_NAME_TEMPLATE)) {
    if ('field' in part && !allowed.has(part.field)) throw new NamingValidationError('nameTemplate', `未知字段：${part.field}`);
  }
}
