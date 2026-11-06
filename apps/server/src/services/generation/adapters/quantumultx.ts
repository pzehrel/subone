import { generateQuantumultXConfig, nodeToQuantumultXProxy, isSupportedByQuantumultX } from '../../../core/generators/quantumultx-generator';
import { quantumultXReferences, quantumultXOwnedNames, quantumultXEntries } from '../../../core/quantumultx-config';
import { GenerationError, generationMetadata, type GenerationPlan, type GenerationDiagnostic } from '../types';

/** Generic/domain DNS rules do not establish a resolver for proxy server hostnames. */
export function renderQuantumultX(plan: GenerationPlan): string {
  validateNodeChains(plan);
  for (const binding of plan.bindings) {
    if (!binding.services.length) continue;
    binding.status = 'unapplied';
    binding.method = 'template-dns';
    binding.appliedServiceIds = [];
    binding.diagnostics.push({ code: 'source-doh-node-resolver-unverified', severity: 'warning', sourceId: binding.sourceId,
      message: 'Quantumult X 1.8.1 未证实来源节点服务器解析、逐 DoH 出站及独立引导能力；此来源绑定未生效，保留模板 DNS' });
  }
  const output = generateQuantumultXConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources,
    { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken });
  validateQuantumultXReferences(output, plan);
  return output;
}

function validateQuantumultXReferences(output: string, plan: GenerationPlan): void {
  const document = { quantumultxLines: output.split('\n') };
  // In provider mode the common plan still supplies the exact names served by SubOne.
  const names = new Set([...quantumultXOwnedNames(document), ...plan.ordinaryNodes.filter(isSupportedByQuantumultX).map(node => node.name)]);
  const diagnostics: GenerationDiagnostic[] = [];
  for (const reference of quantumultXReferences(document)) {
    if (/^(direct|reject|proxy)$/i.test(reference.literal) || names.has(reference.literal)) continue;
    diagnostics.push({ code: 'quantumultx-reference-missing', severity: 'error', message: `Quantumult X 出站引用不可用：${reference.owner} → ${reference.literal}` });
  }
  const graph = new Map<string, string[]>();
  for (const entry of quantumultXEntries(document).filter(entry => entry.section === 'policy')) {
    const owner = entry.parts[0].slice(entry.parts[0].indexOf('=') + 1).trim();
    graph.set(owner, quantumultXReferences({ quantumultxLines: ['[policy]', document.quantumultxLines[entry.index]] }).map(reference => reference.literal));
  }
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
