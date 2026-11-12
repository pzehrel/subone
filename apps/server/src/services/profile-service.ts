import { inputNodes } from './node-naming';
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
import { refreshSource } from './source-service';
import { selectSubscriptionSources } from '../../../../shared/subscription-info';
import { groupReferenceId } from './node-references';
import {
  getAppConfig,
  getGlobalNodesCache,
  setGlobalNodesCache,
} from '../context';

export function ensureCustomSource(_config: AppConfig): SubscriptionSource | undefined {
  return undefined;
}

export function collectNodesFromSources(config: AppConfig): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  (config.sources || []).forEach(s => {
    if (s.enabled && Array.isArray(s.nodes)) {
      s.nodes.filter(node => node.enabled !== false).forEach(n => {
        nodes.push({ ...structuredClone(n), sourceName: s.name, sourceId: s.id });
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

export interface SourceRefreshResult {
  sourceId: string;
  success: boolean;
  nodeCount?: number;
  message?: string;
}

export async function refreshAllSources(config: AppConfig): Promise<{ nodes: ProxyNode[]; results: SourceRefreshResult[] }> {
  const results: SourceRefreshResult[] = [];
  const ids = config.sources.filter(source => source.enabled && source.acquisition !== 'manual' && /^https?:\/\//.test(source.url || '')).map(source => source.id);
  for (const id of ids) {
    try {
      const source = await refreshSource(id);
      results.push({ sourceId: id, success: true, nodeCount: source.nodeCount });
    } catch (error) {
      results.push({ sourceId: id, success: false, message: error instanceof Error ? error.message : '上游更新失败' });
    }
  }
  return { nodes: collectNodesFromSources(getAppConfig()), results };
}

export async function getEffectiveNodes(config?: AppConfig): Promise<ProxyNode[]> {
  const appConfig = config ?? getAppConfig();
  if (config) return applyExtractionRules(inputNodes(collectNodesFromSources(config), config.countryRules), config.rules);
  let cache = getGlobalNodesCache();
  if (cache.length === 0) {
    cache = collectNodesFromSources(appConfig);
    setGlobalNodesCache(cache);
  }
  return applyExtractionRules(inputNodes(cache, appConfig.countryRules), appConfig.rules);
}

export async function getEffectiveNodesForProfile(profile: SubscriptionProfile, config?: AppConfig): Promise<ProxyNode[]> {
  const appConfig = config ?? getAppConfig();
  const allNodes = await getEffectiveNodes(appConfig);
  const filter = profile.nodeFilter || { mode: 'all' };

  if (filter.mode === 'manual' && (!filter.selectedNodeIds || filter.selectedNodeIds.length === 0)) return [];
  let filtered: ProxyNode[] = [];

  // 1. Group / Source selection (Primary mode)
  if (Array.isArray(filter.sourceIds) && filter.sourceIds.length > 0) {
    const selectedSourceIds = new Set(filter.sourceIds);
    const collectedNodes: ProxyNode[] = [];
    const seenKeys = new Set<string>();
    appConfig.sources.forEach(s => {
      if (selectedSourceIds.has(s.id) && s.enabled && s.nodes) {
        s.nodes.filter(node => node.enabled !== false).forEach(n => {
          const key = n.id ? `${n.id}#${n.name}` : `${n.server}:${n.port}:${n.name}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            collectedNodes.push({ ...structuredClone(n), sourceId: s.id, sourceName: s.name });
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
  filtered = applyExtractionRules(inputNodes(filtered, appConfig.countryRules), appConfig.rules);

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

export function getEffectiveGroupsForProfile(profile: SubscriptionProfile, _effectiveNodes?: ProxyNode[], config?: AppConfig): ProxyGroupItem[] {
  const appConfig = config ?? getAppConfig();

  let groups: ProxyGroupItem[];
  if (Array.isArray(profile.selectedGroupIds) && profile.selectedGroupIds.length > 0) {
    const set = new Set(profile.selectedGroupIds);
    groups = (appConfig.proxyGroups || []).filter(g => set.has(g.id));

    // Recursively ensure any groups referenced by selected groups in proxies list are also included
    const includedGroupIds = new Set(groups.map(g => g.id));
    let added = true;
    while (added) {
      added = false;
      const referencedGroupIds = new Set<string>();
      groups.forEach(g => {
        if (g.proxies) {
          g.proxies.forEach(p => {
            const id = groupReferenceId(p);
            const target = id ? appConfig.proxyGroups.find(group => group.id === id) : appConfig.proxyGroups.find(group => group.name === p);
            if (target && !includedGroupIds.has(target.id)) referencedGroupIds.add(target.id);
          });
        }
      });

      if (referencedGroupIds.size > 0) {
        const additionalGroups = (appConfig.proxyGroups || []).filter(g => referencedGroupIds.has(g.id));
        additionalGroups.forEach(ag => {
          if (!includedGroupIds.has(ag.id)) {
            includedGroupIds.add(ag.id);
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

export function getEffectiveSourcesForProfile(profile?: SubscriptionProfile, _effectiveNodes?: ProxyNode[], config?: AppConfig): SubscriptionSource[] {
  const appConfig = config ?? getAppConfig();
  return selectSubscriptionSources(appConfig.sources || [], profile?.nodeFilter?.sourceIds);
}

export function getEffectiveRulesForProfile(profile: SubscriptionProfile, config?: AppConfig): UnifiedRuleItem[] {
  const appConfig = config ?? getAppConfig();
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
