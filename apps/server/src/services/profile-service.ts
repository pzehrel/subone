import {
  AppConfig,
  ProxyNode,
  ConfigTemplate,
  ProxyGroupItem,
  UnifiedRuleItem,
  SubscriptionSource,
  SubscriptionProfile,
} from '../types/index';
import { ClientType } from '../core/parser/ua-detector';
import { formatSourceGroupTag, cleanSourceOrGroupName } from '../core/generators/common';
import { applyExtractionRules } from '../core/filter/extractor';
import { fetchAndParseSource } from '../core/parser/fetcher';
import { saveConfig } from '../storage/db';
import {
  getAppConfig,
  saveAppConfig,
  getGlobalNodesCache,
  setGlobalNodesCache,
} from '../context';

export function ensureCustomSource(config: AppConfig): SubscriptionSource | undefined {
  if (!config.sources || config.sources.length === 0) {
    const defaultManual: SubscriptionSource = {
      id: `manual-${Date.now()}`,
      name: '自建节点',
      type: 'manual',
      enabled: true,
      nodeCount: 0,
      nodes: [],
    };
    config.sources = [defaultManual];
    return defaultManual;
  }
  return config.sources.find(s => s.type === 'manual' || s.id === 'custom');
}

export function collectNodesFromSources(config: AppConfig): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  (config.sources || []).forEach(s => {
    if (s.enabled && Array.isArray(s.nodes)) {
      s.nodes.forEach(n => {
        n.sourceName = s.name;
        n.sourceId = s.id;
        nodes.push(n);
      });
    }
  });
  return nodes;
}

export function ensureCustomProxyGroup(_config: AppConfig): boolean {
  return false;
}

export function ensureAllSourceProxyGroups(_config: AppConfig): boolean {
  return false;
}

export async function refreshAllSources(config: AppConfig): Promise<ProxyNode[]> {
  const allNodes: ProxyNode[] = [];
  const enabledSources = config.sources.filter(s => s.enabled);

  for (const source of enabledSources) {
    if (source.type === 'custom' || !source.url || !source.url.startsWith('http')) {
      if (source.nodes && source.nodes.length > 0) {
        allNodes.push(...source.nodes);
      }
      continue;
    }

    try {
      console.log(`[Fetcher] Refreshing source: ${source.name} (${source.url})`);
      const nodes = await fetchAndParseSource(source, config.countryRules);
      source.lastUpdated = new Date().toISOString();
      source.nodeCount = nodes.length;
      source.nodes = nodes;
      allNodes.push(...nodes);
      console.log(`[Fetcher] Successfully fetched ${nodes.length} nodes from ${source.name}`);
    } catch (err: any) {
      console.error(`[Fetcher] Error fetching source ${source.name}:`, err.message || err);
      if (source.nodes && source.nodes.length > 0) {
        allNodes.push(...source.nodes);
      }
    }
  }

  saveConfig(config);
  setGlobalNodesCache(allNodes);
  return allNodes;
}

export async function getEffectiveNodes(): Promise<ProxyNode[]> {
  const appConfig = getAppConfig();
  let cache = getGlobalNodesCache();
  if (cache.length === 0) {
    cache = collectNodesFromSources(appConfig);
    setGlobalNodesCache(cache);
  }
  return applyExtractionRules(cache, appConfig.rules);
}

export async function getEffectiveNodesForProfile(profile: SubscriptionProfile): Promise<ProxyNode[]> {
  const appConfig = getAppConfig();
  const allNodes = await getEffectiveNodes();
  const filter = profile.nodeFilter || { mode: 'all' };

  let filtered: ProxyNode[] = [];

  // 1. Group / Source selection (Primary mode)
  if (Array.isArray(filter.sourceIds) && filter.sourceIds.length > 0) {
    const selectedSourceIds = new Set(filter.sourceIds);
    const collectedNodes: ProxyNode[] = [];
    const seenKeys = new Set<string>();
    appConfig.sources.forEach(s => {
      if (selectedSourceIds.has(s.id) && s.enabled && s.nodes) {
        s.nodes.forEach(n => {
          const key = n.id ? `${n.id}#${n.name}` : `${n.server}:${n.port}:${n.name}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            collectedNodes.push(n);
          }
        });
      }
    });
    filtered = collectedNodes;
  } else {
    // If no sourceIds specified, default to all available nodes
    filtered = allNodes;
  }

  // 2. Global extraction rules apply
  filtered = applyExtractionRules(filtered, appConfig.rules);

  // 3. Optional Country filter (if specified in profile)
  if (Array.isArray(filter.countryCodes) && filter.countryCodes.length > 0) {
    const countrySet = new Set(filter.countryCodes.map(c => c.toUpperCase()));
    filtered = filtered.filter(n => n.countryCode && countrySet.has(n.countryCode.toUpperCase()));
  }

  // 4. Optional Keywords filter
  if (Array.isArray(filter.includeKeywords) && filter.includeKeywords.length > 0) {
    filtered = filtered.filter(n => filter.includeKeywords!.some(kw => n.name.toLowerCase().includes(kw.toLowerCase())));
  }
  if (Array.isArray(filter.excludeKeywords) && filter.excludeKeywords.length > 0) {
    filtered = filtered.filter(n => !filter.excludeKeywords!.some(kw => n.name.toLowerCase().includes(kw.toLowerCase())));
  }

  // 5. Optional Regex filter
  if (filter.includeRegex && filter.includeRegex.trim()) {
    try {
      const reg = new RegExp(filter.includeRegex.trim(), 'i');
      filtered = filtered.filter(n => reg.test(n.name));
    } catch {}
  }
  if (filter.excludeRegex && filter.excludeRegex.trim()) {
    try {
      const reg = new RegExp(filter.excludeRegex.trim(), 'i');
      filtered = filtered.filter(n => !reg.test(n.name));
    } catch {}
  }

  // 6. Backward compatibility: if legacy selectedNodeIds is explicitly configured and sourceIds was not specified
  if (
    (!filter.sourceIds || filter.sourceIds.length === 0) &&
    Array.isArray(filter.selectedNodeIds) &&
    filter.selectedNodeIds.length > 0
  ) {
    const selSet = new Set(filter.selectedNodeIds);
    filtered = filtered.filter(n => selSet.has(n.id));
  }

  return filtered;
}

export function getEffectiveGroupsForProfile(profile: SubscriptionProfile, _effectiveNodes?: ProxyNode[]): ProxyGroupItem[] {
  const appConfig = getAppConfig();

  let groups: ProxyGroupItem[];
  if (Array.isArray(profile.selectedGroupIds) && profile.selectedGroupIds.length > 0) {
    const set = new Set(profile.selectedGroupIds);
    groups = (appConfig.proxyGroups || []).filter(g => set.has(g.id));

    // Recursively ensure any groups referenced by selected groups in proxies list are also included
    const includedGroupNames = new Set(groups.map(g => g.name));
    let added = true;
    while (added) {
      added = false;
      const referencedGroupNames = new Set<string>();
      groups.forEach(g => {
        if (g.proxies) {
          g.proxies.forEach(p => {
            if (!includedGroupNames.has(p)) {
              referencedGroupNames.add(p);
            }
          });
        }
      });

      if (referencedGroupNames.size > 0) {
        const additionalGroups = (appConfig.proxyGroups || []).filter(g => referencedGroupNames.has(g.name));
        additionalGroups.forEach(ag => {
          if (!includedGroupNames.has(ag.name)) {
            includedGroupNames.add(ag.name);
            groups.push(ag);
            added = true;
          }
        });
      }
    }
  } else {
    groups = appConfig.proxyGroups || [];
  }

  return groups.map(g => ({
    ...g,
    sources: g.sources || g.use,
    use: g.sources || g.use,
    proxies: g.proxies ? [...g.proxies] : undefined,
  }));
}

export function getEffectiveSourcesForProfile(profile?: SubscriptionProfile, _effectiveNodes?: ProxyNode[]): SubscriptionSource[] {
  const appConfig = getAppConfig();
  if (!profile) return appConfig.sources || [];
  if (Array.isArray(profile.nodeFilter?.sourceIds) && profile.nodeFilter.sourceIds.length > 0) {
    const selectedSourceIds = new Set(profile.nodeFilter.sourceIds);
    return (appConfig.sources || []).filter(s => selectedSourceIds.has(s.id));
  }
  return appConfig.sources || [];
}

export function getEffectiveRulesForProfile(profile: SubscriptionProfile): UnifiedRuleItem[] {
  const appConfig = getAppConfig();
  if (Array.isArray(profile.selectedRuleIds) && profile.selectedRuleIds.length > 0) {
    const set = new Set(profile.selectedRuleIds);
    return appConfig.rulesList.filter(r => set.has(r.id));
  }
  return appConfig.rulesList;
}

export function getEffectiveTemplateForProfile(profile: SubscriptionProfile, clientType: ClientType): ConfigTemplate | undefined {
  const appConfig = getAppConfig();
  const customTplId = profile.templates?.[clientType];
  if (customTplId) {
    const found = appConfig.templates.find(t => t.id === customTplId);
    if (found) return found;
  }
  return appConfig.templates.find(t => t.type === clientType && t.isDefault) || appConfig.templates.find(t => t.type === clientType);
}
