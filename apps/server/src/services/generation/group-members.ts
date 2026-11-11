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
  if (!groups.length) return next;
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
        // Try a batch first. A match may have relied on a node rejected by this very filter.
        const trial = (extras: ProxyNode[]) => project(group.id, [...selected, ...extras.map(node => node.id)]);
        const proposed = matches(trial(omitted)).filter(node => !actualIds.has(node.id));
        const verified = new Set(matches(trial(proposed)).map(node => node.id));
        if (proposed.length && proposed.every(node => verified.has(node.id))) {
          for (const node of proposed) selected.add(node.id);
        } else {
          // Admit one independently matching candidate, in inventory order, then recompute its dependencies.
          for (const candidate of omitted) {
            if (matches(trial([candidate])).some(node => node.id === candidate.id)) {
              selected.add(candidate.id);
              break;
            }
          }
        }
      }
    }
    if (selected.size) next.set(group.id, [...selected].sort());
  }
  return next;
}

export function membershipKey(members: ReadonlyMap<string, string[]>): string {
  return JSON.stringify([...members].sort(([left], [right]) => left.localeCompare(right)));
}
