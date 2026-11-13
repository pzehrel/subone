import { managedReferenceTraversal } from '../managed-references';
import { generateQuantumultXConfig, nodeToQuantumultXProxy, isSupportedByQuantumultX } from '../../../core/generators/quantumultx-generator';
import { quantumultXReferences, quantumultXOwnedNames, quantumultXEntries, quantumultXDefinitionNames } from '../../../core/quantumultx-config';
import { registerRuntimeDependencyCollector } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationPlan, type GenerationDiagnostic } from '../types';
import { renderIniDomainDns } from '../native-domain-dns';

/** Source server domains use native scoped DoH entries. */
export function renderQuantumultX(plan: GenerationPlan): string {
  validateQuantumultXNodeChains(plan);
  if (plan.dependencyNodes.length) {
    const template = { quantumultxLines: plan.templateContent.split('\n') };
    const dynamic = quantumultXEntries(template).filter(entry => entry.section === 'policy' && entry.parts.some(part => /server-tag-regex\s*=/.test(part))).map(entry => entry.parts[0].slice(entry.parts[0].indexOf('=') + 1).trim());
    if (quantumultXReferences(template).some(reference => /^proxy$/i.test(reference.literal))) dynamic.push('proxy');
    if (dynamic.length) {
      const generation = generationMetadata(plan);
      generation.diagnostics.push({ code: 'quantumultx-candidate-isolation-unverified', severity: 'error', message: `模板动态策略无法确认隔离必要依赖节点，请使用明确的普通候选：${[...new Set(dynamic)].join('、')}` });
      throw new GenerationError('Quantumult X 普通候选需修复', generation);
    }
  }
  const output = generateQuantumultXConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources,
    { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds), runtimeSources: plan.inventory.sources,
      nodeResource: plan.baseUrl && plan.subToken ? { name: plan.subscriptionName || 'SubOne', url: `${plan.baseUrl.replace(/\/+$/, '')}/s/${encodeURIComponent(plan.subToken)}/nodes/qx` } : undefined });
  validateQuantumultXReferences(output, plan);
  return renderIniDomainDns(output, plan, 'quantumultx');
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
export function validateQuantumultXNodeChains(plan: GenerationPlan): void {
  const diagnostics: GenerationDiagnostic[] = [...plan.ordinaryNodes, ...plan.dependencyNodes].flatMap(node => {
    const original = plan.inventory.nodes.find(entry => entry.node.id === node.id)?.node || node;
    const detour = original.detourRef || original.detour || (original.raw && typeof original.raw === 'object' && (original.raw.detour || original.raw['dialer-proxy']));
    return detour ? [{ code: 'quantumultx-node-chain-unverified', severity: 'error' as const, sourceId: node.sourceId,
      message: `Quantumult X 1.8.0 未证实节点链式出站字段，不能保留连接路径：${node.name}`,
      path: [{ kind: 'outbound' as const, id: node.id, label: node.name }, { kind: 'outbound' as const, id: String(detour), label: String(detour) }] }] : [];
  });
  if (diagnostics.length) { const generation = generationMetadata(plan); generation.diagnostics.push(...diagnostics); throw new GenerationError('Quantumult X 节点连接路径无法表达', generation); }
}

/** Pure provider output carries only the ordinary selected nodes; DNS chains are unused. */
export function renderQuantumultXSource(input: GenerationPlan, sourceId: string) {
  return renderQuantumultXNodes(input, sourceId);
}

/** The aggregate resource keeps the same profile selection and names as the full configuration. */
export function renderQuantumultXNodes(input: GenerationPlan, sourceId?: string) {
  const plan = structuredClone(input);
  plan.target.mode = 'nodes';
  if (sourceId !== undefined) plan.ordinaryNodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  plan.dependencyNodes = [];
  const selectedIds = new Set(plan.ordinaryNodes.map(node => node.id));
  plan.bindings = plan.bindings.flatMap(binding => {
    const nodeIds = binding.nodeIds.filter(id => selectedIds.has(id));
    return nodeIds.length ? [{ ...binding, nodeIds, services: [], status: 'ignored' as const, method: 'nodes-only', appliedServiceIds: [], diagnostics: [] }] : [];
  });
  validateQuantumultXNodeChains(plan);
  return { output: plan.ordinaryNodes.filter(isSupportedByQuantumultX).map(nodeToQuantumultXProxy).join('\n'), contentType: 'text/plain; charset=utf-8' };
}

/** Complete only retained native/managed outbound references, never unapplied source DNS. */
registerRuntimeDependencyCollector('quantumultx', plan => {
  const { result, visit } = managedReferenceTraversal(plan, { resolveNames: true });
  for (const reference of plan.template?.connectionReferences || []) {
    let final = false;
    try { const slot = JSON.parse(JSON.parse(reference.slot)[0]); final = slot[1] === 'filter_local' && slot[2] === 'final'; } catch { /* Another client's slot is not used here. */ }
    if (final && plan.rules.some(rule => rule.enabled && rule.type === 'FINAL')) continue;
    visit(reference.target, ['Quantumult X template', reference.literal]);
  }
  for (const group of plan.groups.filter(group => !plan.dependencyGroupIds.includes(group.id))) visit(`group:${group.id}`, ['Quantumult X policy', group.name]);
  return result;
});
