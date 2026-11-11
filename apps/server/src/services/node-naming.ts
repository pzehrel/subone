import { DEFAULT_NAME_TEMPLATE, parseNameTemplate } from '../../../../shared/source-naming';
import { detectRegion } from '../core/parser/region';
import { detectCountry } from '../core/parser/country';
import type { CountryPatternRule, ProxyNode, SubscriptionSource } from '../types';

export { DEFAULT_NAME_TEMPLATE, validateSourceNaming } from '../../../../shared/source-naming';
export const namingInput = (node: ProxyNode): string => node.localName?.trim() || node.originalName || node.name;

export function nodeInputFields(node: ProxyNode, countryRules?: CountryPatternRule[]) {
  const name = namingInput(node);
  const country = detectCountry(name, countryRules);
  return { name, countryCode: country?.code, countryEmoji: country?.emoji };
}

/** Clone before selection so filters, recognition and fallback share the current input. */
export function inputNodes(nodes: ProxyNode[], countryRules?: CountryPatternRule[]): ProxyNode[] {
  return nodes.map(node => ({ ...structuredClone(node), ...nodeInputFields(node, countryRules) }));
}

export function restoreInputFields(sources: SubscriptionSource[], countryRules?: CountryPatternRule[]) {
  for (const source of sources) {
    for (const node of [...(source.nodes || []), ...(source.infoNodes || [])]) {
      Object.assign(node, nodeInputFields(node, countryRules));
    }
  }
}

// Prepare once per input so speculative ranks use exactly the renderer's template and fallback.
export function prepareNodeName(node: ProxyNode, source?: SubscriptionSource) {
  const input = namingInput(node);
  const region = detectRegion(input);
  const template = source?.nameTemplate ?? DEFAULT_NAME_TEMPLATE;
  const fallback = { region, indexed: false, at: (_index: number) => input };
  if (!region || !template) return fallback;
  const groups = source?.extractRegex ? new RegExp(source.extractRegex, 'i').exec(input)?.groups : undefined;
  const fields: Record<string, string | undefined> = {
    ...groups, upstream_name: source?.name, region: region.name, region_code: region.code, region_emoji: region.emoji,
  };
  const parts = parseNameTemplate(template);
  const pieces: (string | null)[] = [];
  for (const part of parts) {
    if ('text' in part) pieces.push(part.text);
    else if (part.field === 'region_index') pieces.push(null);
    else if (Object.hasOwn(fields, part.field) && fields[part.field]) pieces.push(fields[part.field]!);
    else return fallback;
  }
  return { region, indexed: pieces.includes(null), at: (index: number) => pieces.map(text => text ?? String(index).padStart(2, '0')).join('') };
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
  const byId = new Map(sources.map(source => [source.id, source]));
  return ordered.map(node => {
    const prepared = prepareNodeName(node, byId.get(node.sourceId || ''));
    const region = prepared.region;
    const key = region && regionKey(region);
    const index = key ? (counts.get(key) || 0) + 1 : 0;
    if (key) counts.set(key, index);
    return { ...structuredClone(node), name: prepared.at(index), countryCode: region?.code, countryEmoji: region?.emoji };
  });
}

export const regionKey = (region: NonNullable<ReturnType<typeof detectRegion>>) => `${region.code || ''}:${region.name}`;
