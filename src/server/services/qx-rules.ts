import yaml from 'js-yaml';
import { UnifiedRuleItem } from '../../types/index.js';

const cache = new Map<string, { value: string; expires: number }>();

export function convertClassicalRules(text: string, rule: UnifiedRuleItem): string {
  const content = text.trim();
  const document = /^payload\s*:/m.test(content) ? yaml.load(content) as { payload?: unknown[] } : undefined;
  const lines = document?.payload || content.split(/\r?\n/);
  const mapping: Record<string, string> = {
    DOMAIN: 'host', 'DOMAIN-SUFFIX': 'host-suffix', 'DOMAIN-KEYWORD': 'host-keyword',
    'IP-CIDR': 'ip-cidr', 'IP-CIDR6': 'ip6-cidr', 'IP-ASN': 'ip-asn', GEOIP: 'geoip',
  };
  const target = /^(DIRECT|REJECT)$/i.test(rule.outbound) ? rule.outbound.toLowerCase() : rule.outbound;
  const output: string[] = [];
  for (const raw of lines) {
    if (typeof raw !== 'string') throw new Error('Invalid classical rule');
    const line = raw.trim();
    if (!line || /^(#|;|\/\/)/.test(line)) continue;
    const parts = line.split(',').map(s => s.trim());
    // Desktop process matching has no equivalent in Quantumult X on iOS.
    if (parts[0].toUpperCase() === 'PROCESS-NAME') continue;
    let type = mapping[parts[0].toUpperCase()];
    if (!type || !parts[1]) throw new Error('Unsupported classical rule');
    if (type === 'ip-cidr' && parts[1].includes(':')) type = 'ip6-cidr';
    const suffix = parts.some(s => s === 'no-resolve') ? ',no-resolve' : '';
    output.push(`${type},${parts[1]},${target}${suffix}`);
  }
  if (!output.length) throw new Error('Empty classical rule set');
  return output.join('\n') + '\n';
}

export async function getQuantumultXRules(rule: UnifiedRuleItem): Promise<string> {
  const key = JSON.stringify([rule.payload, rule.outbound]);
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.value;
  try {
    const response = await fetch(rule.payload, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Upstream failed');
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error('Rule set too large');
    const value = convertClassicalRules(text, rule);
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { value, expires: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch {
    if (previous) return previous.value;
    throw new Error('Rule set unavailable');
  }
}
