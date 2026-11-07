import { managedReferenceTraversal } from '../managed-references';
import type { SourceDohService, SubscriptionSource } from '../../../types';
import { splitLoonParameters } from '../../node-references';
import { registerRuntimeDependencyCollector } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationDiagnostic, type GenerationPlan } from '../types';

import { portableDohBootstrapIssue, portableDohUrl, rangePattern, recordDomainDns, resolveNodeDns, templateHostConflict } from '../node-domain-ranges';
import { prependIniSection } from '../native-domain-dns';

type Document = Record<string, any>;
function unsupportedService(service: SourceDohService, source: SubscriptionSource): Pick<GenerationDiagnostic, 'code' | 'message'> | undefined {
  if (service.outbound && service.outbound.kind !== 'direct') return { code: 'source-doh-egress-unapplied', message: 'Loon server-dns 未证实可表达此 DoH 出站；保留模板 DNS' };
  const bootstrapIssue = portableDohBootstrapIssue({ source, service });
  if (bootstrapIssue) return bootstrapIssue;
  const raw = service.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Document;
    const plainQuanx = source.doh?.format === 'quantumultx' && !value.scope && Array.isArray(value.options) && !value.options.length && Object.keys(value).every(key => ['line', 'value', 'options'].includes(key));
    if (!plainQuanx && (value.type !== 'https' || Object.keys(value).some(key => !['type', 'tag', 'server', 'server_port', 'path'].includes(key)))) return { code: 'source-doh-options-unapplied', message: '此 DoH 的连接选项尚不能完整映射到 Loon；保留模板 DNS' };
  } else if (typeof raw === 'string') {
    const suffix = raw.slice(raw.indexOf('#') + 1);
    if (raw.includes('#') && suffix !== 'DIRECT') return { code: 'source-doh-options-unapplied', message: '此 DoH 的 URL 选项尚不能完整映射到 Loon；保留模板 DNS' };
  } else return { code: 'source-doh-options-unapplied', message: '此 DoH 的连接选项尚不能完整映射到 Loon；保留模板 DNS' };
  const url = new URL(service.url);
  // Native documentation defines a comma-separated list but no escaping inside an element.
  if (url.username || url.password || url.hash || /[,"\r\n]/.test(service.url)) return { code: 'source-doh-options-unapplied', message: '此 DoH 的认证、片段或列表分隔符没有已证实的 Loon 写法；保留模板 DNS' };
  return undefined;
}

/** Loon's node DNS field carries the complete native URL list selected by the ranges. */
export function adaptLoonDns(plan: GenerationPlan): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const resolved = resolveNodeDns(plan, true);
  for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes]) {
    const binding = plan.bindings.find(binding => binding.nodeIds.includes(node.id));
    if (node.detourRef || node.detour || node.raw && typeof node.raw === 'object' && (node.raw.detour || node.raw['dialer-proxy'])) {
      binding?.diagnostics.push({ code: 'loon-node-route-unapplied', severity: 'error', sourceId: node.sourceId, message: 'Loon 节点连接出站尚不能完整映射' });
      continue;
    }
    const services = resolved.forNode.get(node.id) || [];
    if (!services.length) continue;
    const urls = services.map(portableDohUrl);
    if (urls.some(url => !url)) {
      for (const entry of services.filter(entry => !portableDohUrl(entry))) {
        const issue = unsupportedService(entry.service, entry.source);
        binding?.diagnostics.push({ ...(issue || { code: 'source-doh-options-unapplied', message: 'DoH 连接参数无法转换为 Loon 节点 DNS' }), severity: 'warning', sourceId: node.sourceId, serviceId: entry.service.id });
      }
      continue;
    }
    result.set(node.id, [...new Set(urls as string[])]);
  }
  const owned = new Set([...result.keys()].map(id => [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.id === id)!.server.toLowerCase()));
  const aliases = [...resolved.aliases].filter(([from]) => owned.has(from));
  const appliedRanges = resolved.ranges.filter(range => range.nodeIds.some(id => result.has(id)));
  plan.templateContent = prependIniSection(plan.templateContent, 'Host', aliases.map(([from, to]) => `${from} = ${to}`), line => {
    const key = /^\s*([^#;][^=]+?)\s*=/.exec(line)?.[1].trim().toLowerCase();
    if (!key || key.startsWith('ssid:')) return line;
    if (owned.has(key) || appliedRanges.some(range => rangePattern(range) === key)) return;
    templateHostConflict(plan, key, appliedRanges);
    return line;
  });
  recordDomainDns(plan, resolved.ranges, 'loon-server-dns', new Map(appliedRanges.map(range => [range, new Set(range.services.map(({ service }) => service.id))])));
  return result;
}

/** Only retained template outbound slots create dependencies; unapplied source DoH does not. */
registerRuntimeDependencyCollector('loon', plan => {
  const { result, visit } = managedReferenceTraversal(plan, { resolveNames: true, expandGroup: group => group.type !== 'relay' && !!((group.sources ?? group.use)?.length || group.filter || !group.proxies?.length) });
  for (const reference of plan.template?.connectionReferences || []) {
    if (plan.rules.some(rule => rule.enabled && rule.type === 'FINAL') && reference.slot.includes('FINAL,')) continue;
    visit(reference.target, ['Loon template', reference.literal]);
  }
  return result;
});

/** Check only concrete native outbound references; no invented DNS transport edges. */
export function validateLoonRuntime(output: string, plan: GenerationPlan): void {
  const groups = new Map<string, string[]>(); const terminals = new Set<string>(); const ruleTargets: string[] = [];
  let section = '';
  for (const line of output.split('\n')) {
    const trimmed = line.trim(); const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (!trimmed || /^[#;]/.test(trimmed)) continue;
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed);
    if (['proxy', 'remote proxy', 'remote filter'].includes(section) && assignment) terminals.add(assignment[1].trim());
    if (section === 'proxy group' && assignment) groups.set(assignment[1].trim(), splitLoonParameters(assignment[2]).slice(1).map(value => value.trim()).filter(value => !value.includes('=')));
    if (section === 'remote rule') {
      const parts = splitLoonParameters(trimmed);
      const policy = parts.find(part => /^\s*policy\s*=/.test(part));
      if (policy) ruleTargets.push(policy.slice(policy.indexOf('=') + 1).trim());
      else if (parts.length > 1 && !parts[1].includes('=')) ruleTargets.push(parts[1].trim());
    }
    if (section === 'rule') {
      const parts = splitLoonParameters(trimmed); let target = parts.length - 1;
      while (target > 0 && /^(no-resolve|src)$/i.test(parts[target].trim())) target--;
      if (target > 0) ruleTargets.push(parts[target].trim());
    }
  }
  // Provider nodes are concrete native declarations fetched from profile-scoped URLs.
  for (const node of [...plan.ordinaryNodes, ...plan.dependencyNodes]) terminals.add(node.name);
  // Keep explicit managed edges visible even when a legacy generator would prune them.
  for (const group of plan.groups) if (group.proxies?.length) groups.set(group.name, [...new Set([...(groups.get(group.name) || []), ...group.proxies])]);
  const builtin = /^(DIRECT|REJECT(?:-IMG|-DICT|-ARRAY|-DROP)?|全部节点)$/i;
  let issue: GenerationDiagnostic | undefined;
  const visit = (name: string, stack: string[]) => {
    if (issue || builtin.test(name) || terminals.has(name)) return;
    if (stack.includes(name)) { issue = { code: 'source-doh-cycle', severity: 'error', message: `Loon 出站依赖循环：${[...stack, name].join(' → ')}` }; return; }
    const members = groups.get(name);
    if (!members?.length) { issue = { code: 'loon-outbound-reference-missing', severity: 'error', message: `Loon 出站引用不存在或策略组没有可用成员：${[...stack, name].join(' → ')}` }; return; }
    for (const member of members) visit(member, [...stack, name]);
  };
  for (const name of [...groups.keys(), ...ruleTargets]) visit(name, []);
  if (issue) {
    if (plan.bindings[0]) plan.bindings[0].diagnostics.push({ ...issue, sourceId: plan.bindings[0].sourceId });
    else throw new GenerationError('Loon 出站引用需修复', { ...generationMetadata(plan), diagnostics: [issue] });
  }
}
