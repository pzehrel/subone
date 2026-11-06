import type { AppConfig, ClientType, ProxyGroupItem, ProxyNode, SubscriptionSource } from '../types';

export const nodeReference = (id: string): string => `node:${id}`;
export const requiresExpandedNodes = (groups: ProxyGroupItem[]): boolean => groups.some(group => group.proxies?.some(value => value.startsWith('node:')));
export const nodeReferenceId = (value: string): string | undefined => value.startsWith('node:') ? value.slice(5) : undefined;

/** Resolve labels only at an explicit write boundary; unavailable stable refs remain editable. */
export function normalizeGroupReferences(group: ProxyGroupItem, config: AppConfig): ProxyGroupItem {
  const nodes = config.sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])]);
  const result = { ...group };
  result.proxies = group.proxies?.map(value => {
    if (nodeReferenceId(value)) return value;
    const nodeMatches = nodes.filter(node => node.name === value || node.id === value);
    const groupMatches = config.proxyGroups.filter(candidate => candidate.name === value);
    const builtinCollision = nodeMatches.length > 0 && /^(direct|reject|block|pass|global|reject-drop)$/i.test(value) ? 1 : 0;
    if (nodeMatches.length + groupMatches.length + builtinCollision > 1) throw new Error(`出站名称不唯一：${value}`);
    return nodeMatches.length === 1 ? nodeReference(nodeMatches[0].id) : value;
  });
  const mounts = group.sources ?? group.use;
  if (mounts) {
    const ids = mounts.map(value => {
      const exact = config.sources.find(source => source.id === value);
      if (exact) return exact.id;
      const matches = config.sources.filter(source => source.name === value);
      if (matches.length > 1) throw new Error(`上游名称不唯一：${value}`);
      return matches[0]?.id ?? value;
    });
    result.sources = ids;
    result.use = [...ids];
  }
  return result;
}

/** Allocate client names once, then resolve all stable edges against this exact selected set. */
export function resolveOutputReferences(nodes: ProxyNode[], groups: ProxyGroupItem[], sources: SubscriptionSource[], client?: ClientType): { nodes: ProxyNode[]; groups: ProxyGroupItem[]; sources: SubscriptionSource[] } {
  const enabledSources = new Set(sources.filter(source => source.enabled).map(source => source.id));
  const selected = nodes.filter(node => node.enabled !== false && (!node.sourceId || enabledSources.has(node.sourceId)));
  const used = new Set([...groups.map(group => group.name), 'DIRECT', 'REJECT', 'direct', 'reject', 'block']);
  const names = new Map<string, string>();
  for (const node of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    let base = node.name.trim() || `${node.type.toUpperCase()}-${node.server}`;
    if (client && !['singbox', 'mihomo'].includes(client)) base = base.replace(/[=,\r\n]/g, '_');
    let name = base; let suffix = 2;
    while (used.has(name)) name = `${base} (${suffix++})`;
    used.add(name); names.set(node.id, name);
  }
  const outputNodes = selected.map(node => {
    const copy = { ...node, name: names.get(node.id)! };
    if (node.detourRef) {
      const targetId = nodeReferenceId(node.detourRef);
      const target = targetId && names.get(targetId);
      copy.detour = target || node.detourRef;
      if (node.raw && typeof node.raw === 'object') {
        copy.raw = { ...node.raw };
        if ('detour' in copy.raw) copy.raw.detour = copy.detour;
        if ('dialer-proxy' in copy.raw) copy.raw['dialer-proxy'] = copy.detour;
      }
    }
    return copy;
  });
  return {
    nodes: outputNodes,
    groups: groups.map(group => ({ ...group, proxies: group.proxies?.flatMap(value => {
      const id = nodeReferenceId(value);
      return id ? names.has(id) ? [names.get(id)!] : [] : [value];
    }) })),
    sources: sources.filter(source => source.enabled).map(source => ({ ...source, nodes: outputNodes.filter(node => node.sourceId === source.id) })),
  };
}

/** Removed owned nodes never retarget a stale selection to another source's lookalike. */
export function removeNodeReferences(config: AppConfig, removedIds: Set<string>): void {
  for (const group of config.proxyGroups) {
    const previous = group.proxies;
    group.proxies = previous?.filter(value => !removedIds.has(nodeReferenceId(value) || ''));
    if (previous?.length && group.proxies?.length === 0) group.proxies = ['DIRECT'];
  }
  for (const profile of config.profiles || []) {
    if (profile.nodeFilter?.selectedNodeIds?.length) {
      profile.nodeFilter.selectedNodeIds = profile.nodeFilter.selectedNodeIds.filter(id => !removedIds.has(id));
      if (!profile.nodeFilter.selectedNodeIds.length) profile.nodeFilter.mode = 'manual';
    }
  }
}
