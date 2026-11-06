import { generateQuantumultXConfig, nodeToQuantumultXProxy, isSupportedByQuantumultX } from '../../../core/generators/quantumultx-generator';
import { quantumultXReferences, quantumultXOwnedNames, quantumultXEntries, quantumultXDefinitionNames } from '../../../core/quantumultx-config';
import { resolveGroupNodes } from '../../../core/generators/group-nodes';
import { registerRuntimeDependencyCollector, type RuntimeDependencyCollection } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationPlan, type GenerationDiagnostic } from '../types';

/** Generic/domain DNS rules do not establish a resolver for proxy server hostnames. */
export function renderQuantumultX(plan: GenerationPlan): string {
  for (const binding of plan.bindings) {
    if (!binding.services.length) continue;
    binding.status = 'unapplied';
    binding.method = 'template-dns';
    binding.appliedServiceIds = [];
    binding.diagnostics.push({ code: 'source-doh-node-resolver-unverified', severity: 'warning', sourceId: binding.sourceId,
      message: 'Quantumult X 1.8.1 未证实来源节点服务器解析、逐 DoH 出站及独立引导能力；此来源绑定未生效，保留模板 DNS' });
  }
  validateNodeChains(plan);
  if (plan.dependencyNodes.length) {
    const template = { quantumultxLines: plan.templateContent.split('\n') };
    const dynamic = quantumultXEntries(template).filter(entry => entry.section === 'policy' && entry.parts.some(part => /server-tag-regex\s*=/.test(part))).map(entry => entry.parts[0].slice(entry.parts[0].indexOf('=') + 1).trim());
    if (quantumultXReferences(template).some(reference => /^proxy$/i.test(reference.literal))) dynamic.push('proxy');
    if (dynamic.length) for (const binding of plan.bindings) binding.diagnostics.push({ code: 'quantumultx-candidate-isolation-unverified', severity: 'warning', sourceId: binding.sourceId, message: `模板动态策略的必要依赖候选隔离未证实：${[...new Set(dynamic)].join('、')}` });
  }
  const output = generateQuantumultXConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources,
    { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds), runtimeSources: plan.inventory.sources });
  validateQuantumultXReferences(output, plan);
  return output;
}

function validateQuantumultXReferences(output: string, plan: GenerationPlan): void {
  const document = { quantumultxLines: output.split('\n') };
  // In provider mode the common plan still supplies the exact names served by SubOne.
  const names = new Set([...quantumultXOwnedNames(document), ...plan.ordinaryNodes.filter(isSupportedByQuantumultX).map(node => node.name)]);
  const diagnostics: GenerationDiagnostic[] = [];
  const definitions = quantumultXDefinitionNames(document);
  for (const name of new Set(definitions)) if (definitions.filter(value => value === name).length > 1) diagnostics.push({ code: 'quantumultx-reference-ambiguous', severity: 'error', message: `Quantumult X 出站名称不唯一：${name}` });
  for (const reference of quantumultXReferences(document)) {
    if (/^(direct|reject|proxy)$/i.test(reference.literal) || names.has(reference.literal)) continue;
    diagnostics.push({ code: 'quantumultx-reference-missing', severity: 'error', message: `Quantumult X 出站引用不可用：${reference.owner} → ${reference.literal}` });
  }
  const graph = new Map<string, string[]>();
  for (const entry of quantumultXEntries(document).filter(entry => entry.section === 'policy')) {
    const owner = entry.parts[0].slice(entry.parts[0].indexOf('=') + 1).trim();
    graph.set(owner, quantumultXReferences({ quantumultxLines: ['[policy]', document.quantumultxLines[entry.index]] }).map(reference => reference.literal));
  }
  // Required explicit managed edges must remain visible when a legacy formatter prunes them.
  for (const group of plan.groups.filter(group => !['direct', 'reject'].includes(group.type))) {
    const members = [...new Set([...(graph.get(group.name) || []), ...(group.proxies || [])])];
    graph.set(group.name, members);
    for (const member of members) if (!/^(direct|reject|proxy)$/i.test(member) && !names.has(member)) diagnostics.push({ code: 'quantumultx-reference-missing', severity: 'error', message: `Quantumult X 出站引用不可用：${group.name} → ${member}` });
  }
  for (const [name, members] of graph) if (!members.length && !quantumultXEntries(document).some(entry => entry.section === 'policy' && entry.parts[0].slice(entry.parts[0].indexOf('=') + 1).trim() === name && entry.parts.some(part => /(?:resource|server)-tag-regex\s*=/.test(part)))) diagnostics.push({ code: 'quantumultx-reference-missing', severity: 'error', message: `Quantumult X 策略组没有可用成员：${name}` });
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (!graph.has(name)) return;
    if (path.includes(name)) { const chain = [...path.slice(path.indexOf(name)), name]; diagnostics.push({ code: 'quantumultx-policy-cycle', severity: 'error', message: `Quantumult X 策略组循环：${chain.join(' → ')}`, path: chain.map(label => ({ kind: 'outbound', id: label, label })) }); return; }
    if (done.has(name)) return;
    for (const member of graph.get(name)!) visit(member, [...path, name]);
    done.add(name);
  };
  for (const name of graph.keys()) visit(name, []);
  if (diagnostics.length) { const generation = generationMetadata(plan); generation.diagnostics.push(...diagnostics); throw new GenerationError('Quantumult X 出站引用需修复', generation); }
}

/** No documented QX node-chain field is substituted for a source detour. */
function validateNodeChains(plan: GenerationPlan): void {
  const diagnostics: GenerationDiagnostic[] = [...plan.ordinaryNodes, ...plan.dependencyNodes].flatMap(node => {
    const original = plan.inventory.nodes.find(entry => entry.node.id === node.id)?.node || node;
    const detour = original.detourRef || original.detour || (original.raw && typeof original.raw === 'object' && (original.raw.detour || original.raw['dialer-proxy']));
    return detour ? [{ code: 'quantumultx-node-chain-unverified', severity: 'error' as const, sourceId: node.sourceId,
      message: `Quantumult X 1.8.1 未证实节点链式出站字段，不能保留连接路径：${node.name}`,
      path: [{ kind: 'outbound' as const, id: node.id, label: node.name }, { kind: 'outbound' as const, id: String(detour), label: String(detour) }] }] : [];
  });
  if (diagnostics.length) { const generation = generationMetadata(plan); generation.diagnostics.push(...diagnostics); throw new GenerationError('Quantumult X 节点连接路径无法表达', generation); }
}

/** Pure provider output carries only the ordinary selected nodes; DNS chains are unused. */
export function renderQuantumultXSource(input: GenerationPlan, sourceId: string) {
  const plan = structuredClone(input);
  plan.target.mode = 'nodes';
  plan.ordinaryNodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  plan.dependencyNodes = [];
  const selectedIds = new Set(plan.ordinaryNodes.map(node => node.id));
  plan.bindings = plan.bindings.flatMap(binding => {
    const nodeIds = binding.nodeIds.filter(id => selectedIds.has(id));
    return nodeIds.length ? [{ ...binding, nodeIds, services: [], status: 'ignored' as const, method: 'nodes-only', appliedServiceIds: [], diagnostics: [] }] : [];
  });
  validateNodeChains(plan);
  return { output: plan.ordinaryNodes.map(nodeToQuantumultXProxy).join('\n'), contentType: 'text/plain; charset=utf-8' };
}

/** Complete only retained native/managed outbound references, never unapplied source DNS. */
registerRuntimeDependencyCollector('quantumultx', plan => {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  const owner = plan.bindings[0]?.sourceId || '';
  const visit = (target: string, reason: string[]): void => {
    if (!/^(node|group|template|builtin|unresolved|ambiguous):/.test(target)) {
      const groups = plan.inventory.groups.filter(group => group.name === target);
      const nodes = plan.inventory.nodes.filter(entry => entry.node.name === target);
      if (groups.length + nodes.length === 1) target = groups.length ? `group:${groups[0].id}` : `node:${nodes[0].node.id}`;
    }
    if (visited.has(target)) return; visited.add(target);
    if (target.startsWith('node:')) {
      const id = target.slice(5), entry = plan.inventory.nodes.find(entry => entry.node.id === id);
      result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state: !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted', bindingSourceId: owner, reason });
    } else if (target.startsWith('group:')) {
      const id = target.slice(6), group = plan.inventory.groups.find(group => group.id === id);
      result.groups.push({ groupId: id, bindingSourceId: owner, reason });
      if (!group || ['direct', 'reject'].includes(group.type)) return;
      for (const member of group.proxies || []) visit(member, [...reason, group.name]);
      if ((group.sources ?? group.use)?.length || group.filter || group.includeAll || !group.proxies?.length) {
        for (const node of resolveGroupNodes(group, plan.ordinaryNodes, plan.inventory.sources)) visit(`node:${node.id}`, [...reason, group.name]);
      }
    }
  };
  for (const reference of plan.template?.connectionReferences || []) {
    let final = false;
    try { const slot = JSON.parse(JSON.parse(reference.slot)[0]); final = slot[1] === 'filter_local' && slot[2] === 'final'; } catch { /* Another client's slot is not used here. */ }
    if (final && plan.rules.some(rule => rule.enabled && rule.type === 'FINAL')) continue;
    visit(reference.target, ['Quantumult X template', reference.literal]);
  }
  for (const group of plan.groups.filter(group => !plan.dependencyGroupIds.includes(group.id))) visit(`group:${group.id}`, ['Quantumult X policy', group.name]);
  return result;
});
