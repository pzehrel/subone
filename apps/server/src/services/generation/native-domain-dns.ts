import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { portableDohBootstrapIssue, portableDohUrl, rangePattern, recordDomainDns, resolveNodeDns, templateHostConflict, type NodeDomainRange } from './node-domain-ranges';
import type { GenerationPlan } from './types';

function portableRanges(plan: GenerationPlan, candidates: NodeDomainRange[]): { ranges: NodeDomainRange[]; urls: Map<NodeDomainRange, string[]> } {
  const ranges: NodeDomainRange[] = [], urls = new Map<NodeDomainRange, string[]>();
  for (const range of candidates) {
    const services = range.services;
    const values = services.map(portableDohUrl);
    if (values.some(value => !value)) {
      for (const binding of plan.bindings.filter(binding => range.nodeIds.some(id => binding.nodeIds.includes(id)))) {
        for (const entry of services.filter(entry => !portableDohUrl(entry))) {
          const issue = portableDohBootstrapIssue(entry) ?? { code: 'source-doh-options-unapplied', message: 'DoH 连接参数无法完整转换，保留模板 DNS' };
          binding.diagnostics.push({ ...issue, severity: 'warning', sourceId: binding.sourceId, serviceId: entry.service.id,
            message: `${rangePattern(range)}：${issue.message}` });
        }
      }
      continue;
    }
    ranges.push(range); urls.set(range, [...new Set(values as string[])]);
  }
  return { ranges, urls };
}

export function prependIniSection(content: string, name: string, additions: string[], edit?: (line: string) => string | undefined): string {
  if (!additions.length && !edit) return content;
  const lines = content.split('\n'); let section = '';
  const retained = lines.flatMap(line => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1].trim().toLowerCase();
    const edited = section === name.toLowerCase() && !header && edit ? edit(line) : line;
    return edited === undefined ? [] : [edited];
  });
  const start = retained.findIndex(line => line.trim().toLowerCase() === `[${name.toLowerCase()}]`);
  if (start < 0 && additions.length) retained.push('', `[${name}]`, ...additions);
  else retained.splice(start + 1, 0, ...additions);
  return retained.join('\n');
}

export function renderShadowrocketDomainDns(content: string, plan: GenerationPlan): string {
  const all = resolveNodeDns(plan, true);
  const { ranges, urls } = portableRanges(plan, all.ranges);
  const patterns = new Set(ranges.map(rangePattern));
  const aliases = [...all.aliases].filter(([domain]) => ranges.some(range => range.domains.includes(domain)));
  const lines = ranges.map(range => `${rangePattern(range)} = server:${urls.get(range)!.join(',')}`);
  lines.push(...aliases.map(([from, to]) => `${from} = ${to}`));
  content = prependIniSection(content, 'Host', lines, line => {
    const key = /^\s*([^#;][^=]+?)\s*=/.exec(line)?.[1].trim().toLowerCase();
    if (!key) return line;
    if (patterns.has(key) || ranges.some(range => range.domains.includes(key))) return;
    templateHostConflict(plan, key, ranges);
    return line;
  });
  recordDomainDns(plan, all.ranges, 'shadowrocket-domain-doh', new Map(ranges.map(range => [range,
    new Set(range.services.map(({ service }) => service.id))])));
  return content;
}

export function renderEgernDomainDns(content: string, plan: GenerationPlan): string {
  const all = resolveNodeDns(plan, true);
  const { ranges, urls } = portableRanges(plan, all.ranges);
  if (!ranges.length) { recordDomainDns(plan, all.ranges, 'egern-domain-doh', new Map()); return content; }
  const doc = yaml.load(content) as Record<string, any>;
  doc.dns ||= {};
  if (Array.isArray(doc.dns.proxy_nameservers) && doc.dns.proxy_nameservers.length) {
    for (const binding of plan.bindings) if (ranges.some(range => range.nodeIds.some(id => binding.nodeIds.includes(id)))) binding.diagnostics.push({
      code: 'egern-proxy-dns-override', severity: 'error', sourceId: binding.sourceId,
      message: '模板 proxy_nameservers 会覆盖来源 DoH 域名规则，请移除该设置',
    });
    return content;
  }
  doc.dns.upstreams ||= {};
  for (const key of Object.keys(doc.dns.hosts || {})) {
    if (ranges.some(range => rangePattern(range) === key.toLowerCase() || range.domains.includes(key.toLowerCase()))) delete doc.dns.hosts[key];
    else templateHostConflict(plan, key, ranges);
  }
  const rules: Record<string, any>[] = [];
  for (const range of ranges) {
    const base = `subone-${createHash('sha256').update(JSON.stringify(urls.get(range))).digest('hex').slice(0, 12)}`;
    let name = base, i = 2;
    while (doc.dns.upstreams[name] && JSON.stringify(doc.dns.upstreams[name]) !== JSON.stringify(urls.get(range))) name = `${base}-${i++}`;
    doc.dns.upstreams[name] = urls.get(range);
    rules.push({ [range.wildcard ? 'domain_wildcard' : 'domain']: { match: rangePattern(range), value: name } });
  }
  doc.dns.forward = [...rules, ...(doc.dns.forward || []).filter((rule: Record<string, any>) => {
    const value = rule.domain ?? rule.domain_wildcard;
    return !value || !ranges.some(range => value.match === rangePattern(range));
  })];
  const aliases = [...all.aliases].filter(([from]) => ranges.some(range => range.domains.includes(from)));
  if (aliases.length) doc.dns.hosts = { ...doc.dns.hosts, ...Object.fromEntries(aliases) };
  recordDomainDns(plan, all.ranges, 'egern-domain-doh', new Map(ranges.map(range => [range, new Set(range.services.map(({ service }) => service.id))])));
  return yaml.dump(doc, { indent: 2, lineWidth: -1, noRefs: true });
}
