import { findJointMembers } from './group-candidates';
import { dynamicGroupNodes } from '../../core/generators/group-nodes';
import type { ProxyNode } from '../../types';
import { nameOutputNodes } from '../node-naming';
import { resolveOutputReferences, templateOutboundNames } from '../node-references';
import type { GenerationPlan } from './types';

/** Allocate trial and actual names through the same client namespace. */
export function outputAllocator(plan: GenerationPlan, uriNodes: boolean) {
  const complete = plan.target.mode === 'complete';
  const reserved = complete && plan.template ? templateOutboundNames(plan.template) : [];
  return (nodes: ProxyNode[], groups = plan.groups) => resolveOutputReferences(
    nameOutputNodes(nodes, plan.inventory.sources), complete ? groups : [],
    plan.inventory.sources, uriNodes ? 'uri' : plan.target.type, reserved,
  );
}

/** Only connection-only groups may introduce dynamic nodes outside the profile selection. */
export function connectionGroupMembers(plan: GenerationPlan, necessary: Set<string>, allocate: ReturnType<typeof outputAllocator>, project: (groupId: string, ids: string[]) => ProxyNode[]) {
  const next = new Map<string, string[]>();
  const groups = plan.groups.filter(group => necessary.has(group.id) && !plan.ordinaryGroupIds.includes(group.id));
  const searchLimited = new Set<string>();
  if (!groups.length) return { next, searchLimited };
  const actual = [...plan.ordinaryNodes, ...plan.dependencyNodes];
  const actualIds = new Set(actual.map(node => node.id));
  const ordinaryIds = new Set(plan.ordinaryNodes.map(node => node.id));
  const named = allocate(actual).nodes;
  const inventory = plan.inventory.nodes.filter(entry => entry.state === 'enabled').map(entry => entry.node);
  const sources = plan.inventory.sources;
  for (const group of groups) {
    // sing-box and Egern widen only explicitly mounted sources. Mihomo also supports inventory-wide groups.
    const wide = (group.sources ?? group.use)?.length || plan.target.type === 'mihomo';
    const matches = (nodes: ProxyNode[]) => dynamicGroupNodes(group, nodes, sources);
    const included = matches(wide ? named : named.filter(node => ordinaryIds.has(node.id)));
    const selected = new Set(included.map(node => node.id));
    const stale = plan.dynamicNodeIds?.get(group.id)?.some(id => !selected.has(id));
    if (wide && !stale) {
      const scoped = dynamicGroupNodes({ ...group, filter: undefined, includeAll: !!group.filter || group.includeAll }, inventory, sources);
      const omitted = scoped.filter(node => !actualIds.has(node.id));
      if (!group.filter) {
        for (const node of omitted) selected.add(node.id);
      } else if (omitted.length) {
        const trial = (ids: string[]) => {
          const found = new Set(matches(project(group.id, [...selected, ...ids])).map(node => node.id));
          return [...selected].every(id => found.has(id)) ? found : new Set<string>();
        };
        const additions = findJointMembers(plan, group.filter, omitted, actualIds, trial);
        if (additions) for (const id of additions) selected.add(id);
        else if (!selected.size && !group.proxies?.length) searchLimited.add(group.id);
      }
    }
    if (selected.size) next.set(group.id, [...selected].sort());
  }
  return { next, searchLimited };
}

export function membershipKey(members: ReadonlyMap<string, string[]>): string {
  return JSON.stringify([...members].sort(([left], [right]) => left.localeCompare(right)));
}
