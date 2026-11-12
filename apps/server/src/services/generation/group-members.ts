import { possibleMembers, searchMemberSets } from './group-candidates';
import { dynamicGroupNodes } from '../../core/generators/group-nodes';
import type { ProxyGroupItem, ProxyNode } from '../../types';
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

type Members = Map<string, string[]>;

function setMembers(members: Members, groupId: string, ids: string[]) {
  if (ids.length) members.set(groupId, ids.sort());
}

/** Connection-only groups may introduce eligible nodes. All such groups see the same
 * completed output, even when a member of one group supplies another group's ordinal. */
export function connectionGroupMembers(plan: GenerationPlan, necessary: Set<string>, project: (members: Members) => ProxyNode[]) {
  const base: Members = new Map();
  const searchLimited = new Set<string>();
  const required = plan.groups.filter(group => necessary.has(group.id));
  const groups = required.filter(group => !plan.ordinaryGroupIds.includes(group.id));
  if (!groups.length) return { next: base, searchLimited };
  const inventory = plan.inventory.nodes.filter(entry => entry.state === 'enabled').map(entry => entry.node);
  const sources = plan.inventory.sources;
  const filtered: { group: ProxyGroupItem; filter: string; scope: ProxyNode[] }[] = [];
  const ordinaryOnly: ProxyGroupItem[] = [];
  for (const group of groups) {
    // sing-box and Egern widen only explicitly mounted sources. Mihomo also supports inventory-wide groups.
    if (!(group.sources ?? group.use)?.length && plan.target.type !== 'mihomo') {
      ordinaryOnly.push(group);
      continue;
    }
    const scope = dynamicGroupNodes({ ...group, filter: undefined, includeAll: !!group.filter || group.includeAll }, inventory, sources);
    if (group.filter) filtered.push({ group, filter: group.filter, scope });
    else setMembers(base, group.id, scope.map(node => node.id));
  }
  const ordinaryIds = new Set(plan.ordinaryNodes.map(node => node.id));
  const matching = (nodes: ProxyNode[]): Members => {
    const members = new Map(base);
    const ordinary = nodes.filter(node => ordinaryIds.has(node.id));
    for (const group of ordinaryOnly) setMembers(members, group.id, dynamicGroupNodes(group, ordinary, sources).map(node => node.id));
    for (const { group } of filtered) setMembers(members, group.id, dynamicGroupNodes(group, nodes, sources).map(node => node.id));
    return members;
  };
  if (!filtered.length) return { next: matching(project(base)), searchLimited };
  // Keep only fixed roots while exploring. Abandoned trials cannot leave extra hops behind.
  const fixed = project(base);
  const fixedIds = new Set(fixed.map(node => node.id));
  const pools = filtered.map(({ group, filter, scope }) => ({
    group, ids: new Set(possibleMembers(plan, scope.filter(node => !fixedIds.has(node.id)), fixedIds, filter, filtered.length > 1)),
  }));
  const eligible = new Set(pools.flatMap(pool => [...pool.ids]));
  const uncovered = (members: Members, nodes: ProxyNode[]) => {
    const ordinary = nodes.filter(node => ordinaryIds.has(node.id));
    return required.filter(group => {
      if (group.proxies?.length || ['direct', 'reject'].includes(group.type)) return false;
      if (plan.ordinaryGroupIds.includes(group.id)) return !dynamicGroupNodes(group, ordinary, sources).length;
      return !members.has(group.id);
    });
  };
  const trial = (ids: string[]) => {
    const pins = new Map(base);
    for (const pool of pools) setMembers(pins, pool.group.id, ids.filter(id => pool.ids.has(id)));
    const matchedGroups = matching(project(pins));
    const matched = new Set(filtered.flatMap(({ group }) => matchedGroups.get(group.id) || []));
    // Drop nonmatching pins, assign each retained member to its actual matching groups,
    // then recheck against just those roots. This excludes unrelated numbering filler.
    if ([...matched].some(id => !fixedIds.has(id))) {
      const verified = project(matchedGroups);
      if (!uncovered(matchedGroups, verified).length && membershipKey(matchedGroups) === membershipKey(matching(verified))) {
        return { matched, solution: matchedGroups };
      }
    }
    return { matched };
  };
  const solution = searchMemberSets(inventory.filter(node => eligible.has(node.id)), trial);
  const next = solution ?? matching(fixed);
  if (solution === undefined) {
    for (const group of uncovered(next, fixed)) searchLimited.add(group.id);
  }
  return { next, searchLimited };
}

export function membershipKey(members: ReadonlyMap<string, string[]>): string {
  return JSON.stringify([...members].sort(([left], [right]) => left.localeCompare(right)));
}
