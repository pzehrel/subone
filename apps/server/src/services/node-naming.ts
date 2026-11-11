import { DEFAULT_NAME_TEMPLATE, parseNameTemplate } from '../../../../shared/source-naming';
import { detectRegion } from '../core/parser/region';
import type { ProxyNode, SubscriptionSource } from '../types';

export { DEFAULT_NAME_TEMPLATE, validateSourceNaming } from '../../../../shared/source-naming';
export const namingInput = (node: ProxyNode): string => node.localName?.trim() || node.originalName || node.name;

/** Clone before selection so filters, recognition and fallback share the current input. */
export function inputNodes(nodes: ProxyNode[]): ProxyNode[] {
  return nodes.map(node => {
    const name = namingInput(node);
    const region = detectRegion(name);
    return { ...structuredClone(node), name, countryCode: region?.code, countryEmoji: region?.emoji };
  });
}

/** Number the actual selected set in upstream and upstream-document order. */
export function nameOutputNodes(nodes: ProxyNode[], sources: SubscriptionSource[]): ProxyNode[] {
  const positions = new Map(sources.flatMap((source, sourceIndex) => (source.nodes || []).map((node, nodeIndex) => [node.id, [sourceIndex, nodeIndex] as const] as const)));
  const ordered = [...nodes].sort((a, b) => {
    const left = positions.get(a.id) || [sources.length, 0];
    const right = positions.get(b.id) || [sources.length, 0];
    return left[0] - right[0] || left[1] - right[1];
  });
  const counts = new Map<string, number>();
  return ordered.map(node => {
    const copy = structuredClone(node);
    const input = namingInput(node);
    copy.name = input;
    const region = detectRegion(input);
    if (!region) return copy;
    const index = (counts.get(region.name) || 0) + 1;
    counts.set(region.name, index);
    const source = sources.find(source => source.id === node.sourceId);
    const template = source?.nameTemplate ?? DEFAULT_NAME_TEMPLATE;
    if (!template) return copy;
    const groups = source?.extractRegex ? new RegExp(source.extractRegex, 'i').exec(input)?.groups : undefined;
    const fields: Record<string, string | undefined> = { ...groups, upstream_name: source?.name, region: region.name, region_code: region.code, region_emoji: region.emoji, region_index: String(index).padStart(2, '0') };
    const parts = parseNameTemplate(template);
    if (parts.some(part => 'field' in part && (fields[part.field] === undefined || fields[part.field] === ''))) return copy;
    copy.name = parts.map(part => 'text' in part ? part.text : fields[part.field]).join('');
    return copy;
  });
}
