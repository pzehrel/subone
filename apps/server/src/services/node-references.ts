import yaml from 'js-yaml';
import { quantumultXOwnedNames, quantumultXReferences } from '../core/quantumultx-config';
import { mihomoDnsFragment, withMihomoDnsRoute } from '../core/mihomo-dns';
import type { AppConfig, ClientType, ConfigTemplate, ProxyGroupItem, ProxyNode, SubscriptionSource, TemplateConnectionReference } from '../types';

export const nodeReference = (id: string): string => `node:${id}`;
export const requiresExpandedNodes = (groups: ProxyGroupItem[]): boolean => groups.some(group => group.proxies?.some(value => value.startsWith('node:')));
export const nodeReferenceId = (value: string): string | undefined => value.startsWith('node:') ? value.slice(5) : undefined;
export const groupReference = (id: string): string => `group:${id}`;
export const groupReferenceId = (value: string): string | undefined => value.startsWith('group:') ? value.slice(6) : undefined;

/** Resolve labels only at an explicit write boundary; unavailable stable refs remain editable. */
export function normalizeGroupReferences(group: ProxyGroupItem, config: AppConfig): ProxyGroupItem {
  const nodes = config.sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])]);
  const result = { ...group };
  result.proxies = group.proxies?.map(value => {
    if (nodeReferenceId(value) || groupReferenceId(value) || value.startsWith('template:') || value.startsWith('unresolved:') || value.startsWith('ambiguous:')) return value;
    const nodeMatches = nodes.filter(node => node.name === value || node.id === value);
    const groupMatches = config.proxyGroups.filter(candidate => candidate.name === value);
    const nativeMatch = !builtins.test(value) && config.templates.some(template => templateOutboundNames(template).has(value)) ? 1 : 0;
    const builtinCollision = nodeMatches.length + groupMatches.length > 0 && builtins.test(value) ? 1 : 0;
    if (nodeMatches.length + groupMatches.length + builtinCollision + nativeMatch > 1) throw new Error(`出站名称不唯一：${value}`);
    return nodeMatches.length === 1 ? nodeReference(nodeMatches[0].id) : groupMatches.length === 1 ? groupReference(groupMatches[0].id) : nativeMatch ? `template:${value}` : builtins.test(value) ? value : `unresolved:${value}`;
  });
  const mounts = group.sources ?? group.use;
  if (mounts) {
    const ids = mounts.map(value => {
      const exact = config.sources.find(source => source.id === value);
      if (exact) return exact.id;
      const matches = config.sources.filter(source => source.name === value);
      if (matches.length > 1) throw new Error(`上游名称不唯一：${value}`);
      return matches[0]?.id ?? value;
    });
    result.sources = ids;
    result.use = [...ids];
  }
  return result;
}

/** Allocate client names once, then resolve all stable edges against this exact selected set. */
export function resolveOutputReferences(nodes: ProxyNode[], groups: ProxyGroupItem[], sources: SubscriptionSource[], client?: ClientType | 'uri', reservedNames: Iterable<string> = []): { nodes: ProxyNode[]; groups: ProxyGroupItem[]; sources: SubscriptionSource[] } {
  const enabledSources = new Set(sources.filter(source => source.enabled).map(source => source.id));
  const selected = nodes.filter(node => node.enabled !== false && (!node.sourceId || enabledSources.has(node.sourceId)));
  const owned = new Set(reservedNames);
  const used = new Set([...owned, ...(client === 'uri' ? [] : ['direct', 'reject', 'block', 'pass', 'global', 'reject-drop', 'dns-out', 'compatible'].flatMap(name => [name, name.toUpperCase()]))]);
  const names = new Map<string, string>();
  const groupNames = new Map<string, string>();
  for (const group of [...groups].sort((a, b) => a.id.localeCompare(b.id))) {
    let base = group.name.trim() || 'Group';
    if (client && !['singbox', 'mihomo', 'egern', 'uri'].includes(client)) base = base.replace(/[=,\r\n]/g, '_');
    let name = base; let suffix = 2;
    while (used.has(name) || client !== 'uri' && builtins.test(name)) name = `${base} (${suffix++})`;
    used.add(name); groupNames.set(group.id, name);
  }
  if (client !== 'uri') used.add('🎯 本地直连');
  for (const node of [...selected].sort((a, b) => a.id.localeCompare(b.id))) {
    let base = node.name.trim() || `${node.type.toUpperCase()}-${node.server}`;
    if (client && !['singbox', 'mihomo', 'egern', 'uri'].includes(client)) base = base.replace(/[=,\r\n]/g, '_');
    let name = base; let suffix = 2;
    while (used.has(name) || client !== 'uri' && builtins.test(name)) name = `${base} (${suffix++})`;
    used.add(name); names.set(node.id, name);
  }
  const outputNodes = selected.map(node => {
    const copy = { ...node, name: names.get(node.id)! };
    if (node.detourRef) {
      const targetId = nodeReferenceId(node.detourRef);
      const target = targetId && names.get(targetId);
      copy.detour = target || node.detourRef;
      if (node.raw && typeof node.raw === 'object') {
        copy.raw = { ...node.raw };
        if ('detour' in copy.raw) copy.raw.detour = copy.detour;
        if ('dialer-proxy' in copy.raw) copy.raw['dialer-proxy'] = copy.detour;
      }
    }
    return copy;
  });
  return {
    nodes: outputNodes,
    groups: groups.map(group => ({ ...group, name: groupNames.get(group.id)!, proxies: group.proxies?.flatMap(value => {
      const id = nodeReferenceId(value);
      const groupId = groupReferenceId(value);
      const legacyMatches = groups.filter(candidate => candidate.name === value);
      const legacyName = legacyMatches.length === 1 && groupNames.get(legacyMatches[0].id);
      if (value.startsWith('template:')) {
        const name = value.slice(9);
        return [owned.has(name) ? name : `unresolved:${name}`];
      }
      return id ? [names.get(id) || value] : groupId ? [groupNames.get(groupId) || value] : [legacyName || value];
    }) })),
    sources: sources.filter(source => source.enabled).map(source => ({ ...source, nodes: outputNodes.filter(node => node.sourceId === source.id) })),
  };
}

interface TemplateSlot { slot: string; literal: string; write(value: string): void }
const builtins = /^(direct|reject|block|pass|global|reject-drop|rules|dns-out|compatible)$/i;
const templateArray = (value: any): any[] => Array.isArray(value) ? value : [];
const stableJson = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function templateDocument(template: ConfigTemplate): any {
  try {
    if (['loon', 'shadowrocket'].includes(template.type)) return { loonLines: template.content.split('\n') };
    if (template.type === 'singbox') return JSON.parse(template.content);
    if (template.type === 'quantumultx') return { quantumultxLines: template.content.split('\n') };
    if (['mihomo', 'egern'].includes(template.type)) return yaml.load(template.content);
  } catch { /* Editing an incomplete template must remain possible. */ }
  return undefined;
}

function loonSections(document: any): { section: string; line: string; index: number }[] {
  let section = '';
  return (document?.loonLines || []).map((line: string, index: number) => {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) section = header[1].toLowerCase();
    return { section, line, index };
  });
}

/** Split native INI parameters without splitting quoted URLs or logical rule expressions. */
export function splitLoonParameters(value: string): string[] {
  const parts: string[] = []; let start = 0; let quote = false; let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start)); return parts;
}

function ownedOutboundNames(document: any, type: ClientType): Set<string> {
  if (type === 'quantumultx' && document) return quantumultXOwnedNames(document);
  if (type === 'egern') return new Set([...templateArray(document?.proxies), ...templateArray(document?.policy_groups)].map(entry => entry && typeof entry === 'object' ? (Object.values(entry)[0] as any)?.name : undefined).filter((name): name is string => typeof name === 'string'));
  if (['loon', 'shadowrocket'].includes(type)) return new Set(loonSections(document).flatMap(({ section, line }) => {
    if (!(type === 'shadowrocket' ? ['proxy', 'proxy group'] : ['proxy', 'proxy group', 'remote proxy', 'remote filter']).includes(section) || /^\s*[#;]/.test(line)) return [];
    const match = /^\s*([^=]+?)\s*=/.exec(line); return match ? [match[1]] : [];
  }));
  const entries = type === 'singbox' ? templateArray(document?.outbounds) : [...templateArray(document?.proxies), ...templateArray(document?.['proxy-groups'])];
  return new Set(entries.map((entry: any) => type === 'singbox' ? entry?.tag : entry?.name).filter((name: unknown): name is string => typeof name === 'string'));
}

export function templateOutboundNames(template: ConfigTemplate): Set<string> {
  return ownedOutboundNames(templateDocument(template), template.type);
}

/** Visit only client fields whose values identify an outbound, never arbitrary matching text. */
function templateSlots(document: any, type: ClientType): TemplateSlot[] {
  const slots: TemplateSlot[] = [];
  const add = (owner: unknown[], object: any, key: string | number) => {
    if (typeof object?.[key] !== 'string') return;
    slots.push({ slot: JSON.stringify([type, ...owner, key]), literal: object[key], write: value => { object[key] = value; } });
  };
  const ownerKey = (entry: any, index: number, name: string) => typeof entry?.[name] === 'string' ? entry[name] : `#${index}`;
  if (!document || typeof document !== 'object') return slots;
  if (type === 'quantumultx') return quantumultXReferences(document);
  if (['loon', 'shadowrocket'].includes(type)) {
    for (const { section, line, index } of loonSections(document)) {
      if (!line.trim() || /^\s*[#;\[]/.test(line)) continue;
      const assignment = /^([^=]+?)=(.*)$/.exec(line);
      const prefix = section === 'proxy group' && assignment ? assignment[1] + '=' : '';
      const parts = splitLoonParameters(prefix ? assignment![2] : line);
      const addPart = (part: number, owner: unknown[], option = '') => {
        const value = parts[part]; const content = option ? value.slice(value.indexOf('=') + 1) : value;
        slots.push({ slot: JSON.stringify([type, ...owner, part]), literal: content.trim(), write: target => {
          const spacing = /^(\s*).*?(\s*)$/.exec(content)!;
          parts[part] = (option ? value.slice(0, value.indexOf('=') + 1) : '') + spacing[1] + target + spacing[2];
          document.loonLines[index] = prefix + parts.join(',');
        } });
      };
      if (section === 'proxy group' && assignment) {
        for (let part = 1; part < parts.length; part++) if (!parts[part].includes('=')) addPart(part, ['group', assignment[1].trim()]);
      } else if (section === 'rule') {
        let target = parts.length - 1;
        while (target > 0 && /^(no-resolve|src)$/i.test(parts[target].trim())) target--;
        if (target > 0) { const identity = [...parts]; identity[target] = '$outbound'; addPart(target, ['rule', identity.join(',')]); }
      } else if (type === 'loon' && section === 'remote rule') {
        const policy = parts.findIndex(part => /^\s*policy\s*=/.test(part));
        if (policy >= 0) addPart(policy, ['remote-rule', parts[0].trim()], 'policy');
        else if (parts.length > 1 && !parts[1].includes('=')) addPart(1, ['remote-rule', parts[0].trim()]);
      }
    }
  } else if (type === 'singbox') {
    for (const [index, server] of templateArray(document.dns?.servers).entries()) add(['dns', ownerKey(server, index, 'tag')], server, 'detour');
    for (const [index, outbound] of templateArray(document.outbounds).entries()) {
      const owner = ['outbound', ownerKey(outbound, index, 'tag')];
      add(owner, outbound, 'detour'); add(owner, outbound, 'default');
      if (Array.isArray(outbound?.outbounds)) outbound.outbounds.forEach((_value: unknown, member: number) => add([...owner, 'outbounds'], outbound.outbounds, member));
    }
    add(['route'], document.route, 'final');
    const routeRules = (rules: any[], parent: unknown[]) => {
      const occurrences = new Map<string, number>();
      for (const rule of templateArray(rules)) {
        const identity = { ...rule }; delete identity.outbound; delete identity.rules;
        const key = stableJson(identity); const occurrence = occurrences.get(key) || 0;
        occurrences.set(key, occurrence + 1);
        const owner = [...parent, key, occurrence];
        add(owner, rule, 'outbound');
        if (Array.isArray(rule?.rules)) routeRules(rule.rules, [...owner, 'rules']);
      }
    };
    routeRules(document.route?.rules, ['route', 'rules']);
  } else if (type === 'egern') {
    const typed = (entry: any): any => entry && typeof entry === 'object' && Object.keys(entry).length === 1 ? Object.values(entry)[0] : undefined;
    add(['config'], document, 'default_proxy_group'); add(['config'], document, 'default_subscription_group');
    for (const [index, entry] of templateArray(document.proxies).entries()) {
      const proxy = typed(entry); add(['proxy', ownerKey(proxy, index, 'name')], proxy, 'prev_hop');
    }
    for (const [index, entry] of templateArray(document.policy_groups).entries()) {
      const group = typed(entry); const owner = ['group', ownerKey(group, index, 'name')];
      add(owner, group, 'prev_hop'); add(owner, group, 'default_policy');
      if (Array.isArray(group?.rules)) group.rules.forEach((entry: any, ruleIndex: number) => add([...owner, 'rules', ruleIndex], typed(entry), 'policy'));
      if (Array.isArray(group?.policies)) group.policies.forEach((_value: unknown, member: number) => add([...owner, 'policies'], group.policies, member));
    }
    const occurrences = new Map<string, number>();
    for (const entry of templateArray(document.rules)) {
      const rule = typed(entry);
      if (!rule || typeof rule !== 'object') continue;
      const identity = { ...rule }; delete identity.policy;
      const key = stableJson([Object.keys(entry)[0], identity]);
      const occurrence = occurrences.get(key) || 0; occurrences.set(key, occurrence + 1);
      add(['rule', key, occurrence], rule, 'policy');
    }
  } else if (type === 'mihomo') {
    for (const [index, proxy] of templateArray(document.proxies).entries()) add(['proxy', ownerKey(proxy, index, 'name')], proxy, 'dialer-proxy');
    for (const [index, group] of templateArray(document['proxy-groups']).entries()) {
      if (Array.isArray(group?.proxies)) group.proxies.forEach((_value: unknown, member: number) => add(['group', ownerKey(group, index, 'name'), 'proxies'], group.proxies, member));
    }
    for (const [index, rule] of templateArray(document.rules).entries()) {
      if (typeof rule !== 'string') continue;
      const parts = rule.split(',');
      let target = parts.length - 1;
      while (target > 0 && /^(no-resolve|src)$/i.test(parts[target].trim())) target--;
      if (target < 1) continue;
      const identity = [...parts]; identity[target] = '$outbound';
      slots.push({ slot: JSON.stringify([type, 'rule', identity.join(',')]), literal: parts[target].trim(), write: value => { parts[target] = value; document.rules[index] = parts.join(','); } });
    }
    const dnsOccurrences = new Map<string, number>();
    const dnsValues = (container: any, key: string | number, owner: unknown[]) => {
      const value = container?.[key];
      if (Array.isArray(value)) { value.forEach((_item, index) => dnsValues(value, index, [...owner, key])); return; }
      if (typeof value !== 'string' || !value.includes('#')) return;
      const hash = value.indexOf('#');
      const literal = mihomoDnsFragment(value).route;
      if (!literal) return;
      const identity = JSON.stringify([type, 'dns', ...owner, typeof key === 'string' ? key : '', value.slice(0, hash)]);
      const occurrence = dnsOccurrences.get(identity) || 0; dnsOccurrences.set(identity, occurrence + 1);
      slots.push({ slot: JSON.stringify([identity, occurrence]), literal, write: target => { container[key] = withMihomoDnsRoute(value, target); } });
    };
    for (const key of ['nameserver', 'fallback', 'proxy-server-nameserver', 'default-nameserver', 'direct-nameserver']) dnsValues(document.dns, key, []);
    for (const policy of ['nameserver-policy', 'proxy-server-nameserver-policy']) for (const key of Object.keys(document.dns?.[policy] || {})) dnsValues(document.dns[policy], key, [policy]);
  }
  return slots;
}

/** Persist identity at explicit template writes; unchanged slots retain their original target. */
export function prepareTemplateReferences(template: ConfigTemplate, config: AppConfig, previous?: ConfigTemplate): ConfigTemplate {
  const document = templateDocument(template);
  const owned = ownedOutboundNames(document, template.type);
  const old = new Map((previous?.connectionReferences || []).map(reference => [reference.slot, reference]));
  const nodes = config.sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])]);
  const references: TemplateConnectionReference[] = templateSlots(document, template.type).map(slot => {
    const prior = old.get(slot.slot);
    if (prior?.literal === slot.literal) return prior;
    if (owned.has(slot.literal)) return { ...slot, target: `template:${slot.literal}` };
    if (builtins.test(slot.literal)) return { ...slot, target: `builtin:${slot.literal}` };
    const nodeId = nodeReferenceId(slot.literal); const groupId = groupReferenceId(slot.literal);
    if (nodeId || groupId) return { ...slot, target: slot.literal };
    const matches = [
      ...nodes.filter(node => node.name === slot.literal).map(node => nodeReference(node.id)),
      ...config.proxyGroups.filter(group => group.name === slot.literal).map(group => groupReference(group.id)),
    ];
    if (matches.length > 1) throw new Error(`出站名称不唯一：${slot.literal}`);
    return { ...slot, target: matches[0] || `unresolved:${slot.literal}` };
  }).map(({ slot, literal, target }) => ({ slot, literal, target }));
  return { ...template, connectionReferences: references };
}

/** Rewrite a parsed clone only; the saved client document remains exact user evidence. */
export function resolveTemplateReferences(template: ConfigTemplate, nodes: ProxyNode[], groups: ProxyGroupItem[]): string {
  const document = templateDocument(template);
  if (!document || !template.connectionReferences?.length) return template.content;
  const references = new Map(template.connectionReferences.map(reference => [reference.slot, reference]));
  const nodeNames = new Map(nodes.map(node => [node.id, node.name]));
  const groupNames = new Map(groups.map(group => [group.id, group.name]));
  for (const slot of templateSlots(document, template.type)) {
    const reference = references.get(slot.slot);
    if (!reference || reference.literal !== slot.literal) continue;
    const nodeId = nodeReferenceId(reference.target); const groupId = groupReferenceId(reference.target);
    const name = nodeId ? nodeNames.get(nodeId) : groupId ? groupNames.get(groupId) : undefined;
    if (name) slot.write(name);
    else if (nodeId || groupId || reference.target.startsWith('unresolved:')) slot.write(reference.target);
  }
  if (template.type === 'quantumultx') return document.quantumultxLines.join('\n');
  return ['loon', 'shadowrocket'].includes(template.type) ? document.loonLines.join('\n') : template.type === 'singbox' ? JSON.stringify(document) : yaml.dump(document, { lineWidth: -1, noRefs: true });
}

/** Removed owned nodes never retarget a stale selection to another source's lookalike. */
export function removeNodeReferences(config: AppConfig, removedIds: Set<string>): void {
  if (!removedIds.size) return;
  config.templates = config.templates.map(template => prepareTemplateReferences(template, config, template));
  const names = new Map(config.sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])]).map(node => [node.id, node.name]));
  for (const group of config.proxyGroups) {
    group.proxies = group.proxies?.map(value => {
      const id = nodeReferenceId(value);
      return id && removedIds.has(id) ? `unresolved:${names.get(id) || '已移除节点'}` : value;
    });
  }
  for (const template of config.templates) {
    for (const reference of template.connectionReferences || []) {
      const id = nodeReferenceId(reference.target);
      if (id && removedIds.has(id)) reference.target = `unresolved:${names.get(id) || reference.literal}`;
    }
  }
  for (const node of config.sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])])) {
    const id = node.detourRef && nodeReferenceId(node.detourRef);
    if (id && removedIds.has(id)) node.detourRef = `unresolved:${names.get(id) || '已移除节点'}`;
  }
  for (const profile of config.profiles || []) {
    if (profile.nodeFilter?.selectedNodeIds?.length) {
      profile.nodeFilter.selectedNodeIds = profile.nodeFilter.selectedNodeIds.filter(id => !removedIds.has(id));
      if (!profile.nodeFilter.selectedNodeIds.length) profile.nodeFilter.mode = 'manual';
    }
  }
}

export function removeGroupReferences(config: AppConfig, group: ProxyGroupItem): void {
  config.proxyGroups = config.proxyGroups.map(owner => normalizeGroupReferences(owner, config));
  config.templates = config.templates.map(template => prepareTemplateReferences(template, config, template));
  const target = groupReference(group.id);
  for (const rule of config.rulesList) if (rule.outbound === group.name || rule.outbound === target) rule.outbound = `unresolved:${group.name}`;
  for (const owner of config.proxyGroups) owner.proxies = owner.proxies?.map(value => value === target ? `unresolved:${group.name}` : value);
  for (const template of config.templates) {
    for (const reference of template.connectionReferences || []) {
      if (reference.target === target) reference.target = `unresolved:${group.name}`;
    }
  }
  for (const profile of config.profiles || []) profile.selectedGroupIds = profile.selectedGroupIds?.filter(id => id !== group.id);
}
