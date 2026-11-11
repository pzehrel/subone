import { groupNamePattern } from '../../core/generators/group-nodes';
import type { ProxyNode } from '../../types';
import { prepareNodeName, regionKey } from '../node-naming';
import { clientNodeBaseName, templateOutboundNames } from '../node-references';
import { needsHostnameLookup } from './runtime-dependencies';
import type { GenerationPlan } from './types';

function dependencyPriority(node: ProxyNode): number {
  if (node.detourRef || node.detour || node.raw?.detour || node.raw?.['dialer-proxy']) return 2;
  return needsHostnameLookup(node.server) ? 1 : 0;
}

/** Bound possible names before trying combinations. A possible match is only a candidate:
 * completion and the real allocator still have to establish that all members match together. */
function possibleMembers(plan: GenerationPlan, omitted: ProxyNode[], actualIds: Set<string>, filter: string) {
  const pattern = groupNamePattern(filter);
  const candidates = new Set(omitted.map(node => node.id));
  // Direct IP exits introduce neither a node-server lookup nor another hop.
  // Otherwise allow the entire enabled inventory as potential support for the ordinal.
  const mayIntroduceHops = omitted.some(node => dependencyPriority(node) > 0);
  const counts = new Map<string, number>();
  const result: string[] = [];
  const baseMatches = new Map<string, boolean>();
  // In a literal keyword ending in a letter, the match cannot finish in ' (2)'.
  // Exact literal names and anchored lists of literal names cannot end there either.
  const literal = /^[\p{L}\p{N}_ -]*[\p{L}_-]$/u;
  const exact = /^\^(?:[\p{L}\p{N}_ -]+|\((?:\?:)?[\p{L}\p{N}_ -]+(?:\|[\p{L}\p{N}_ -]+)*\))\$$/u;
  const checkSuffixes = !literal.test(pattern.source) && !exact.test(pattern.source);
  // Screening is optional. Once its work allowance is used, keep the remaining
  // candidates for real projections instead of enumerating every rank × suffix.
  let comparisons = 100_000 + plan.inventory.nodes.length * 4;
  // 'base (2)' and later suffixes can only be occupied by nodes, groups or template
  // outbounds. The client's fixed reserved names do not have numeric suffixes.
  const templateCount = plan.template ? templateOutboundNames(plan.template).size : 0;
  const suffixLimit = 2 + plan.inventory.nodes.length + plan.inventory.groups.length + templateCount;
  const canMatch = (base: string) => {
    const cached = baseMatches.get(base);
    if (cached !== undefined) return cached;
    if (--comparisons < 0) return true;
    let matches = pattern.test(base);
    for (let suffix = 2; checkSuffixes && !matches && suffix <= suffixLimit; suffix++) {
      if (--comparisons < 0) return true;
      matches = pattern.test(`${base} (${suffix})`);
    }
    baseMatches.set(base, matches);
    return matches;
  };
  for (const source of plan.inventory.sources) {
    if (!source.enabled) continue;
    for (const node of source.nodes || []) {
      if (node.enabled === false) continue;
      const candidate = candidates.has(node.id);
      if (!candidate && !mayIntroduceHops && !actualIds.has(node.id)) continue;
      const name = prepareNodeName(node, source);
      const key = name.region && regionKey(name.region);
      const maxIndex = key ? (counts.get(key) || 0) + 1 : 1;
      let possible = false;
      if (candidate) {
        for (let index = 1; index <= (name.indexed ? maxIndex : 1); index++) {
          if (canMatch(clientNodeBaseName(node, name.at(index), plan.target.type))) { possible = true; break; }
        }
        if (possible) result.push(node.id);
      }
      if (key && (possible || mayIntroduceHops || actualIds.has(node.id))) counts.set(key, maxIndex);
    }
  }
  return result;
}

/** Verify plausible memberships with their real dependencies and target names.
 * Undefined signals that the bounded combination search has not proved emptiness. */
export function findJointMembers(plan: GenerationPlan, filter: string, omitted: ProxyNode[], actualIds: Set<string>, trial: (ids: string[]) => Set<string>) {
  const candidates = possibleMembers(plan, omitted, actualIds, filter);
  if (!candidates.length) return [];
  const possible = new Set(candidates);
  const byDependency = omitted.filter(node => possible.has(node.id)).sort((a, b) => dependencyPriority(b) - dependencyPriority(a));
  const ordered = byDependency.map(node => node.id);
  const batch = trial(candidates);
  const proposed = candidates.filter(id => batch.has(id));
  if (proposed.length === candidates.length) return proposed;
  if (proposed.length) {
    const verified = trial(proposed);
    if (proposed.every(id => verified.has(id))) return proposed;
    // A rejected exit may supply the very hop that makes the first matches valid.
    // Try these supports before combinations of interchangeable terminal nodes.
    for (const node of byDependency) {
      if (!dependencyPriority(node)) break;
      if (batch.has(node.id)) continue;
      const withHop = [...proposed, node.id];
      const matches = trial(withHop);
      if (withHop.every(id => matches.has(id))) return withHop;
    }
  }
  let remaining = candidates.length + 256;
  for (let size = 1; size < candidates.length; size++) {
    const indices = Array.from({ length: size }, (_, index) => index);
    while (true) {
      if (remaining-- <= 0) return undefined;
      const ids = indices.map(index => ordered[index]);
      const matches = trial(ids);
      if (ids.every(id => matches.has(id))) return ids;
      let position = size - 1;
      while (position >= 0 && indices[position] === candidates.length - size + position) position--;
      if (position < 0) break;
      indices[position]++;
      for (let next = position + 1; next < size; next++) indices[next] = indices[next - 1] + 1;
    }
  }
  return [];
}
