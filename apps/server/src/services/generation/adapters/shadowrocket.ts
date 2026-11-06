import { resolveGroupNodes } from '../../../core/generators/group-nodes';
import { splitLoonParameters } from '../../node-references';
import { registerRuntimeDependencyCollector, type RuntimeDependencyCollection } from '../runtime-dependencies';
import { nodeToUri } from '../../../core/generators/shadowrocket-generator';
import type { ProxyNode } from '../../../types';
import { GenerationError, generationMetadata, type GenerationDiagnostic, type GenerationPlan } from '../types';
import { retainTemplateDns } from './unsupported';

function hasNodeRoute(node: ProxyNode): boolean {
  return !!(node.detourRef || node.detour || node.raw && typeof node.raw === 'object' && (node.raw.detour || node.raw['dialer-proxy']));
}
function diagnose(plan: GenerationPlan, diagnostic: GenerationDiagnostic): void {
  const binding = plan.bindings.find(binding => binding.sourceId === diagnostic.sourceId) || plan.bindings[0];
  if (binding) binding.diagnostics.push(diagnostic);
  else throw new GenerationError('Shadowrocket 出站引用需修复', { ...generationMetadata(plan), diagnostics: [diagnostic] });
}

/** Shadowrocket2.2.93: generic DoH is proven, source-specific node DNS is not. */
export function adaptShadowrocketDns(plan: GenerationPlan): void {
  retainTemplateDns(plan);
  for (const group of plan.groups) if (!['select', 'urltest', 'fallback', 'relay', 'direct', 'reject'].includes(group.type)) {
    diagnose(plan, { code: 'shadowrocket-strategy-unapplied', severity: 'error',
      message: `Shadowrocket 完整输出尚未证实 ${group.type} 策略组的写法：${group.name}` });
  }
  for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes]) if (hasNodeRoute(node)) {
    diagnose(plan, { code: 'shadowrocket-node-route-unapplied', severity: 'error', sourceId: node.sourceId,
      message: `Shadowrocket 节点 ${node.name} 的连接出站没有已证实的完整配置写法`, path: [{ kind: 'outbound', id: node.id, label: node.name }] });
  }
}

/** URI entries cannot carry cross-node connection references or client DNS definitions. */
export function diagnosePureNodes(plan: GenerationPlan): void {
  for (const node of plan.ordinaryNodes) {
    const path = [{ kind: 'outbound' as const, id: node.id, label: node.name }];
    if (hasNodeRoute(node)) diagnose(plan, { code: 'nodes-only-chain-unapplied', severity: 'warning', sourceId: node.sourceId, path,
      message: `纯节点条目 ${node.name} 不承载跨节点连接出站；仅提供节点连接参数` });
    if (!nodeToUri(node)) diagnose(plan, { code: 'nodes-only-protocol-unsupported', severity: 'warning', sourceId: node.sourceId, path,
      message: `纯节点输出尚不支持 ${node.type}，已略过 ${node.name}` });
  }
}

/** Complete only ordinary native template/group references; source DNS is deliberately unused. */
registerRuntimeDependencyCollector('shadowrocket', plan => {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  const owner = plan.bindings[0]?.sourceId || '';
  const visit = (target: string, reason: string[]) => {
    if (!target.startsWith('node:') && !target.startsWith('group:')) return;
    if (visited.has(target)) return; visited.add(target);
    if (target.startsWith('node:')) {
      const id = target.slice(5); const entry = plan.inventory.nodes.find(entry => entry.node.id === id);
      result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state: !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted', bindingSourceId: owner, reason });
    } else {
      const id = target.slice(6); const group = plan.inventory.groups.find(group => group.id === id);
      result.groups.push({ groupId: id, bindingSourceId: owner, reason });
      if (!group || ['direct', 'reject'].includes(group.type)) return;
      for (const member of group.proxies || []) visit(member, [...reason, group.name]);
      if (group.type !== 'relay' && ((group.sources ?? group.use)?.length || group.filter || !group.proxies?.length)) {
        for (const node of resolveGroupNodes(group, plan.ordinaryNodes, plan.inventory.sources)) visit(`node:${node.id}`, [...reason, group.name]);
      }
    }
  };
  for (const group of plan.groups) visit(`group:${group.id}`, ['Shadowrocket group', group.name]);
  for (const reference of plan.template?.connectionReferences || []) {
    if (plan.rules.some(rule => rule.enabled && rule.type === 'FINAL') && /final\s*,/i.test(reference.slot)) continue;
    visit(reference.target, ['Shadowrocket template', reference.literal]);
  }
  return result;
});

/** Validate concrete carried declarations and policies without constructing a DNS graph. */
export function validateShadowrocketRuntime(output: string, plan: GenerationPlan): void {
  const declarations = new Map<string, number>(); const groups = new Map<string, string[]>(); const policies: string[] = [];
  let section = '';
  for (const line of output.split('\n')) {
    const trimmed = line.trim(); const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed);
    if (assignment && ['proxy', 'proxy group'].includes(section)) {
      const name = assignment[1].trim(); declarations.set(name, (declarations.get(name) || 0) + 1);
      if (section === 'proxy group') groups.set(name, splitLoonParameters(assignment[2]).slice(1).map(value => value.trim()).filter(value => !value.includes('=')));
    }
    if (section === 'rule') {
      const parts = splitLoonParameters(trimmed); let target = parts.length - 1;
      while (target > 0 && /^(no-resolve|src)$/i.test(parts[target].trim())) target--;
      if (target > 0) policies.push(parts[target].trim());
    }
  }
  const builtin = /^(DIRECT|REJECT(?:-IMG|-DICT|-ARRAY|-DROP)?|PASS)$/i;
  const visited = new Set<string>(); let issue: GenerationDiagnostic | undefined;
  const visit = (name: string, stack: string[]) => {
    if (issue || builtin.test(name)) return;
    if (stack.includes(name)) { issue = { code: 'source-doh-cycle', severity: 'error', message: `Shadowrocket 出站依赖循环：${[...stack, name].join(' → ')}` }; return; }
    if (declarations.get(name) !== 1 || groups.has(name) && !groups.get(name)!.length) {
      issue = { code: 'shadowrocket-outbound-reference-missing', severity: 'error', message: `Shadowrocket 出站引用不存在、名称不唯一或策略组没有成员：${[...stack, name].join(' → ')}` }; return;
    }
    if (visited.has(name)) return;
    for (const member of groups.get(name) || []) visit(member, [...stack, name]);
    visited.add(name);
  };
  for (const name of [...declarations.keys(), ...policies]) visit(name, []);
  if (issue) diagnose(plan, { ...issue, sourceId: plan.bindings[0]?.sourceId });
}
