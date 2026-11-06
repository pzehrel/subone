import { ProxyGroupItem, ProxyNode, SubscriptionSource } from '../../types/index';
import { cleanSourceOrGroupName } from './common';

export function resolveGroupNodes(group: ProxyGroupItem, nodes: ProxyNode[], sources: SubscriptionSource[]): ProxyNode[] {
  nodes = nodes.filter(node => node.enabled !== false && (sources.length === 0 || sources.some(source => source.enabled && source.id === node.sourceId)));
  const uses = group.sources || group.use || [];
  const normalize = (value: string) => cleanSourceOrGroupName(value).trim().toLowerCase();
  const wanted = new Set(uses.map(normalize));
  const selected = sources.filter(s => s.enabled && (wanted.has(normalize(s.id)) || wanted.has(normalize(s.name))));
  let result = wanted.size
    ? nodes.filter(n => selected.some(s => n.sourceId === s.id || n.sourceName === s.name))
    : nodes;
  if (group.filter) {
    const pattern = group.filter.replace(/\(\?i\)/g, '');
    const regex = new RegExp(pattern, 'i');
    result = result.filter(n => regex.test(n.name));
  }
  return result;
}
