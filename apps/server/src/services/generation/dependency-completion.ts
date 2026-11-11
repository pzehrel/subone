import type { ProxyNode } from '../../types';
import { collectRuntimeDependencies } from './runtime-dependencies';
import { connectionGroupMembers, membershipKey, type outputAllocator } from './group-members';
import { GenerationError, generationMetadata, type GenerationPlan } from './types';

export function bindNodes(plan: GenerationPlan) {
  const nodeOnly = plan.target.mode === 'nodes';
  const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes];
  plan.bindings = plan.inventory.sources.flatMap(source => {
    const nodeIds = nodes.filter(node => node.sourceId === source.id).map(node => node.id);
    if (!nodeIds.length) return [];
    return [{ sourceId: source.id, sourceName: source.name, batchId: source.doh?.batchId, updatedAt: source.doh?.updatedAt,
      nodeIds, services: structuredClone(source.doh?.services || []), status: nodeOnly ? 'ignored' as const : 'template' as const,
      method: nodeOnly ? 'nodes-only' : 'template-dns', appliedServiceIds: [], diagnostics: [] }];
  });
}

/** Complete stable references from the same original roots for each proposed membership. */
export function completeOutputDependencies(plan: GenerationPlan, supportsNode: (node: ProxyNode) => boolean, allocate: ReturnType<typeof outputAllocator>) {
  const groups = plan.groups;
  const complete = (plan: GenerationPlan) => {
    let necessaryGroups = new Set<string>();
    plan.groups = [...groups];
    plan.ordinaryGroupIds = groups.map(group => group.id);
    plan.dependencyGroupIds = [];
    plan.dependencyNodes = [];
    plan.dependencyReasons = [];
    let changed: boolean;
    do {
      bindNodes(plan);
      changed = false;
      const required = collectRuntimeDependencies(plan);
      const ordinaryGroups = required.groups.filter(requirement => requirement.ordinary && !plan.ordinaryGroupIds.includes(requirement.groupId));
      if (ordinaryGroups.length) {
        plan.ordinaryGroupIds.push(...new Set(ordinaryGroups.map(requirement => requirement.groupId)));
        changed = true;
      }
      necessaryGroups = new Set(required.groups.filter(group => group.ordinary === false).map(group => group.groupId));
      const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
      for (const requirement of required.nodes) {
        if (requirement.state !== 'omitted' || included.has(requirement.nodeId)) continue;
        const entry = plan.inventory.nodes.find(entry => entry.node.id === requirement.nodeId);
        if (!entry || entry.state !== 'enabled') continue;
        if (!supportsNode(entry.node)) {
          const generation = generationMetadata(plan);
          generation.diagnostics.push({ code: plan.target.type === 'quantumultx' ? 'quantumultx-reference-missing' : 'required-node-unsupported', severity: 'error', sourceId: entry.sourceId, message: `目标客户端无法输出必要节点：${entry.node.name}` });
          throw new GenerationError('必要连接需修复', generation);
        }
        plan.dependencyNodes.push(structuredClone(entry.node));
        plan.dependencyReasons!.push(requirement);
        included.add(entry.node.id); changed = true;
      }
      for (const requirement of required.groups) {
        if (plan.groups.some(group => group.id === requirement.groupId)) continue;
        const group = plan.inventory.groups.find(group => group.id === requirement.groupId);
        if (!group) continue;
        plan.groups.push(structuredClone(group)); plan.dependencyGroupIds.push(group.id); changed = true;
      }
    } while (changed);
    return necessaryGroups;
  };
  // Rebuild from the original roots when a name filter changes. This drops obsolete
  // members as well as any DNS, groups or node chains reachable only through them.
  const seen = new Set<string>();
  plan.dynamicNodeIds = new Map();
  while (true) {
    const necessaryGroups = complete(plan);
    const project = (groupId: string, ids: string[]) => {
      const trial = { ...plan, dynamicNodeIds: new Map(plan.dynamicNodeIds).set(groupId, ids) };
      complete(trial);
      return allocate([...trial.ordinaryNodes, ...trial.dependencyNodes], trial.groups).nodes;
    };
    const { next, searchLimited } = connectionGroupMembers(plan, necessaryGroups, allocate, project);
    const key = membershipKey(next);
    if (key === membershipKey(plan.dynamicNodeIds)) {
      if (!searchLimited.size) return necessaryGroups;
      const generation = generationMetadata(plan);
      for (const group of plan.groups.filter(group => searchLimited.has(group.id))) {
        generation.diagnostics.push({ code: 'group-naming-search-limit', severity: 'error', message: `必要策略组「${group.name}」的候选组合过多，请缩小筛选范围或指定出站` });
      }
      throw new GenerationError('必要连接需修复', generation);
    }
    if (seen.has(key)) {
      const generation = generationMetadata(plan);
      const names = plan.groups.filter(group => necessaryGroups.has(group.id)).map(group => group.name);
      generation.diagnostics.push({ code: 'group-naming-cycle', severity: 'error', message: `必要策略组「${names.join('、')}」的成员和最终名称无法同时满足，请调整筛选条件或指定出站` });
      throw new GenerationError('必要连接需修复', generation);
    }
    seen.add(key);
    plan.dynamicNodeIds = next;
  }
}
