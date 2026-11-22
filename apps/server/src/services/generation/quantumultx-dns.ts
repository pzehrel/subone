import { splitQuanxDnsValues } from '../../core/parser/source-doh';
import { portableDohBootstrapIssue, portableDohUrl, resolveNodeAliases } from './node-domain-ranges';
import type { GenerationBinding, GenerationPlan } from './types';

function globalDohUrls(plan: GenerationPlan): string[] {
  const bindings = new Map(plan.bindings.map(binding => [binding.sourceId, binding]));
  const pool = new Map<string, NonNullable<GenerationBinding['effectiveServices']>[number]>();
  for (const source of plan.inventory.sources) {
    const binding = bindings.get(source.id);
    if (!binding?.nodeIds.length || !binding.services.length) continue;
    const unsupported = binding.services.filter(service => !portableDohUrl({ source, service }));
    if (unsupported.length) {
      binding.status = 'unapplied';
      for (const service of unsupported) {
        const bootstrap = portableDohBootstrapIssue({ source, service });
        binding.diagnostics.push({ code: bootstrap?.code ?? 'source-doh-options-unapplied', severity: 'warning',
          sourceId: source.id, serviceId: service.id, message: bootstrap
            ? '无法保留独立引导解析器，该来源的 DoH 未加入全局列表'
            : '无法保留连接参数，该来源的 DoH 未加入全局列表' });
      }
      continue;
    }
    for (const service of binding.services) {
      binding.appliedServiceIds.push(service.id);
      if (!pool.has(service.url)) pool.set(service.url, { sourceId: source.id, serviceId: service.id, url: service.url });
    }
  }
  const shared = [...pool.values()];
  for (const binding of plan.bindings) {
    binding.effectiveServices = shared;
    if (!shared.length) continue;
    binding.method = 'quantumultx-global-doh';
    if (binding.status !== 'unapplied') binding.status = 'applied';
  }
  return [...pool.keys()];
}

function retainTemplateDns(line: string, urls: Set<string>, aliases: ReadonlyMap<string, string>): string | undefined {
  const setting = /^(\s*(doh-server|alias|address)\s*=\s*)(.*)$/i.exec(line);
  if (!setting) return line;
  if (setting[2].toLowerCase() === 'doh-server') {
    if (!urls.size) return line;
    const values = splitQuanxDnsValues(setting[3]);
    if (!values.every(value => /^https:\/\//i.test(value))) return line;
    for (const value of values) urls.add(value);
    return;
  }
  if (!aliases.size) return line;
  const values = splitQuanxDnsValues(setting[3]);
  const options = values.findIndex(value => /^(?:included_ssids|excluded_ssids)\s*=/i.test(value));
  const hosts = options < 0 ? values : values.slice(0, options);
  const retained = hosts.filter(value => !aliases.has(/^\/([^/]+)\//.exec(value)?.[1].toLowerCase() ?? ''));
  if (retained.length === hosts.length) return line;
  if (retained.length) return setting[1] + [...retained, ...values.slice(hosts.length)].join(', ');
}

export function renderQuantumultXDns(content: string, plan: GenerationPlan): string {
  const urls = new Set(globalDohUrls(plan));
  const aliases = resolveNodeAliases(plan);
  if (!urls.size && !aliases.size) return content;

  const lines: string[] = [];
  let inDns = false, dnsStart = -1, dnsEnd = -1;
  for (const line of content.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inDns = header[1].trim().toLowerCase() === 'dns';
      lines.push(line);
      if (inDns) {
        if (dnsStart < 0) dnsStart = lines.length;
        dnsEnd = lines.length;
      }
      continue;
    }
    const retained = inDns ? retainTemplateDns(line, urls, aliases) : line;
    if (retained === undefined) continue;
    lines.push(retained);
    if (inDns) dnsEnd = lines.length;
  }
  if (dnsStart < 0) {
    lines.push('', '[dns]');
    dnsStart = dnsEnd = lines.length;
  }
  // Keep conditional template rules before the unconditional default.
  while (dnsEnd > dnsStart && !lines[dnsEnd - 1].trim()) dnsEnd--;
  if (urls.size) lines.splice(dnsEnd, 0, `doh-server = ${[...urls].join(', ')}`);
  lines.splice(dnsStart, 0, ...[...aliases].map(([from, to]) => `alias = /${from}/${to}`));
  return lines.join('\n');
}
