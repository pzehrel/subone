import type { ProxyGroupItem } from '../../types';
import { resolveGroupNodes } from '../../core/generators/group-nodes';
import type { RuntimeDependencyCollection } from './runtime-dependencies';
import type { GenerationPlan } from './types';

/** Walk managed references while each client supplies its native roots and expansion rules. */
export function managedReferenceTraversal(plan: GenerationPlan, options: {
  resolveNames?: boolean;
  expandGroup: (group: ProxyGroupItem) => boolean;
}) {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  const owner = plan.bindings[0]?.sourceId || '';
  const visit = (reference: string, reason: string[]): void => {
    let target = reference;
    if (options.resolveNames && !/^(node|group|template|builtin|unresolved|ambiguous):/.test(target)) {
      const groups = plan.inventory.groups.filter(group => group.name === target);
      const nodes = plan.inventory.nodes.filter(entry => entry.node.name === target);
      if (groups.length + nodes.length === 1) target = groups.length ? `group:${groups[0].id}` : `node:${nodes[0].node.id}`;
    }
    if (visited.has(target)) return;
    visited.add(target);
    if (target.startsWith('node:')) {
      const id = target.slice(5), entry = plan.inventory.nodes.find(entry => entry.node.id === id);
      result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state: !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted', bindingSourceId: owner, reason });
    } else if (target.startsWith('group:')) {
      const id = target.slice(6), group = plan.inventory.groups.find(group => group.id === id);
      result.groups.push({ groupId: id, bindingSourceId: owner, reason });
      if (!group || ['direct', 'reject'].includes(group.type)) return;
      const path = [...reason, group.name];
      for (const member of group.proxies || []) visit(member, path);
      // Dynamic ordinary candidates never draw from the wider dependency inventory.
      if (options.expandGroup(group)) for (const node of resolveGroupNodes(group, plan.ordinaryNodes, plan.inventory.sources)) visit(`node:${node.id}`, path);
    }
  };
  return { result, visit };
}
