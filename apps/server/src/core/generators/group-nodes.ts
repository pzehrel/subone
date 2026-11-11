import { ProxyGroupItem, ProxyNode, SubscriptionSource } from '../../types/index';
import { cleanSourceOrGroupName } from './common';

/** Completed plans carry their final members in proxies. Standalone generators also accept saved groups. */
export type OutputGroup = ProxyGroupItem & { membersResolved?: true };

export function dynamicGroupNodes(group: ProxyGroupItem, nodes: ProxyNode[], sources: SubscriptionSource[]): ProxyNode[] {
  if (['direct', 'reject', 'relay'].includes(group.type)) return [];
  if ((group.sources ?? group.use)?.length || group.filter || group.includeAll || ['♻️ 自动选择', '👉 手动选择'].includes(group.name)) {
    return resolveGroupNodes(group, nodes, sources);
  }
  return [];
}

export function resolveGroupNodes(group: ProxyGroupItem, nodes: ProxyNode[], sources: SubscriptionSource[]): ProxyNode[] {
  nodes = nodes.filter(node => node.enabled !== false && (sources.length === 0 || sources.some(source => source.enabled && source.id === node.sourceId)));
  const uses = group.sources || group.use || [];
  const normalize = (value: string) => cleanSourceOrGroupName(value).trim().toLowerCase();
  const selected = new Set(uses.flatMap(value => {
    const exact = sources.find(source => source.id.toLowerCase() === value.toLowerCase());
    if (exact) return exact.enabled ? [exact.id] : [];
    return sources.filter(source => source.enabled && normalize(source.name) === normalize(value)).map(source => source.id);
  }));
  let result = uses.length ? nodes.filter(node => node.sourceId && selected.has(node.sourceId)) : nodes;
  if (group.filter) {
    const pattern = group.filter.replace(/\(\?i\)/g, '');
    const regex = new RegExp(pattern, 'i');
    result = result.filter(n => regex.test(n.name));
  }
  return result;
}
