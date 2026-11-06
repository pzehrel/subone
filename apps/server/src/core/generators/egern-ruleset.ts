import yaml from 'js-yaml';
import { isIP } from 'node:net';
import type { UnifiedRuleItem } from '../../types';

export interface EgernRuleSource { url: string; format: 'text' | 'yaml' | 'singbox-json'; behavior?: 'domain' | 'ipcidr' | 'classical' }

/** Binary inputs require an independently verified source counterpart. */
export function egernRuleSource(rule: UnifiedRuleItem): EgernRuleSource | undefined {
  if (rule.clientUrls?.egern) return /\.json(?:[?#].*)?$/i.test(rule.clientUrls.egern) ? { url: rule.clientUrls.egern, format: 'singbox-json' } : undefined;
  // The sing branch publishes these typed JSON files next to their compiled SRS.
  const official = rule.payload.replace(/^https:\/\/gh-proxy\.com\/(?=https:\/\/raw\.githubusercontent\.com\/)/, '');
  if (/^https:\/\/raw\.githubusercontent\.com\/MetaCubeX\/meta-rules-dat\/sing\/geo\/(geosite|geoip)\/[^/?#]+\.srs$/.test(official)) return { url: official.replace(/\.srs$/, '.json'), format: 'singbox-json' };
  if (/\.json(?:[?#].*)?$/i.test(rule.payload)) return { url: rule.payload, format: 'singbox-json' };
  if (rule.format === 'text' || /\.(list|txt|text)(?:[?#].*)?$/i.test(rule.payload)) return { url: rule.payload, format: 'text', behavior: rule.behavior };
  if (rule.format === 'yaml' || /\.ya?ml(?:[?#].*)?$/i.test(rule.payload)) return { url: rule.payload, format: 'yaml', behavior: rule.behavior };
  return undefined;
}

const classicalTypes: Record<string, string> = { DOMAIN: 'domain_set', 'DOMAIN-SUFFIX': 'domain_suffix_set', 'DOMAIN-KEYWORD': 'domain_keyword_set', 'DOMAIN-REGEX': 'domain_regex_set', 'IP-CIDR': 'ip_cidr_set', 'IP-CIDR6': 'ip_cidr6_set', GEOIP: 'geoip_set', 'IP-ASN': 'asn_set' };
const nativeSets = new Set(['domain_set', 'domain_suffix_set', 'domain_keyword_set', 'domain_regex_set', 'domain_wildcard_set', 'geoip_set', 'ip_cidr_set', 'ip_cidr6_set', 'asn_set', 'url_regex_set', 'user_agent_set', 'ssid_set', 'bssid_set', 'cellular_set', 'protocol_set', 'dest_port_set']);

/** Fail the complete conversion on unknown semantics, never skip a rule. */
export function convertEgernRules(text: string, source: EgernRuleSource): string {
  const result: Record<string, string[] | boolean> = {};
  const add = (key: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid rule value');
    if (key === 'ip_cidr_set' && value.includes(':')) key = 'ip_cidr6_set';
    if (key === 'ip_cidr_set' || key === 'ip_cidr6_set') {
      const parts = value.split('/'); const [address, mask] = parts; const family = isIP(address);
      if (parts.length > 2 || !family || mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) > (family === 4 ? 32 : 128))) throw new Error('Invalid IP range');
      if (mask === undefined) value = `${value}/${family === 4 ? 32 : 128}`;
    }
    const values = result[key] as string[] | undefined;
    if (values) values.push(value as string); else result[key] = [value as string];
  };
  if (source.format === 'singbox-json') {
    const document = JSON.parse(text);
    if (!Array.isArray(document.rules) || Object.keys(document).some(key => !['version', 'rules'].includes(key))) throw new Error('Unsupported sing-box rule set');
    const mapping: Record<string, string> = { domain: 'domain_set', domain_suffix: 'domain_suffix_set', domain_keyword: 'domain_keyword_set', domain_regex: 'domain_regex_set', ip_cidr: 'ip_cidr_set' };
    for (const rule of document.rules) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Invalid sing-box rule');
      const keys = Object.keys(rule);
      if (!keys.length || keys.some(key => !mapping[key]) || keys.includes('ip_cidr') && keys.length > 1) throw new Error('Unsupported sing-box rule semantics');
      for (const [key, values] of Object.entries(rule)) for (const value of Array.isArray(values) ? values : [values]) add(mapping[key], value);
    }
  } else {
    let lines: unknown[];
    if (source.format === 'yaml') {
      const document: any = yaml.load(text);
      if (document && typeof document === 'object' && !Array.isArray(document) && !('payload' in document)) {
        for (const [key, values] of Object.entries(document)) {
          if (key === 'no_resolve' && typeof values === 'boolean') { result.no_resolve = values; continue; }
          if (!nativeSets.has(key) || !Array.isArray(values)) throw new Error('Unsupported native rule set');
          for (const value of values) add(key, value);
        }
        return yaml.dump(result, { lineWidth: -1 });
      }
      if (!Array.isArray(document?.payload)) throw new Error('Invalid YAML rule payload');
      lines = document.payload;
    } else lines = text.split(/\r?\n/);
    for (const value of lines) {
      if (typeof value !== 'string') throw new Error('Invalid text rule');
      const line = value.trim(); if (!line || /^(#|;|\/\/)/.test(line)) continue;
      if (source.behavior === 'domain') {
        if (line.startsWith('+.')) add('domain_suffix_set', line.slice(2));
        else if (line.startsWith('.')) add('domain_suffix_set', line.slice(1));
        else if (/[?*]/.test(line)) add('domain_wildcard_set', line);
        else add('domain_set', line);
      } else if (source.behavior === 'ipcidr') add('ip_cidr_set', line);
      else {
        const parts = line.split(',').map(value => value.trim());
        const key = classicalTypes[parts[0].toUpperCase()];
        if (!key || !parts[1] || parts.length > 3 || parts[2] && parts[2] !== 'no-resolve') throw new Error('Unsupported classical rule');
        // no_resolve is file-wide in Egern; mixing it would change other rules.
        if (parts[2] === 'no-resolve') throw new Error('Per-rule no-resolve cannot be represented in this set');
        add(key, parts[1]);
      }
    }
  }
  if (!Object.keys(result).length) throw new Error('Empty rule set');
  return yaml.dump(result, { lineWidth: -1 });
}
