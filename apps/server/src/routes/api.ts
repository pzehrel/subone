import { Hono, type Handler } from 'hono';
import type { BodyEnv } from '../middlewares/body';
import crypto from 'crypto';
import yaml from 'js-yaml';
import { appConfig, getBaseUrl, setGlobalNodesCache, getGlobalNodesCache, setAppConfig } from '../context';
import { saveConfig, saveServerConfig, generateRandomSubToken } from '../storage/db';
import { fetchAndParseSource, parseRawContent } from '../core/parser/fetcher';
import { applySubscriptionInfo, validateInfoRegex } from '../core/parser/subscription-info';
import {
  parseProxyGroupsText,
  parseLocalRulesText,
  parseRemoteRulesText,
  parseUnifiedRulesText,
  exportRulesToText,
} from '../core/parser/rules-parser';
import {
  formatSourceGroupTag,
  cleanSourceOrGroupName,
  getSourceGroupPrefix,
} from '../core/generators/common';
import {
  AppConfig,
  ProxyNode,
  ConfigTemplate,
  ProxyGroupItem,
  UnifiedRuleItem,
  CountryPatternRule,
  SubscriptionSource,
  SubscriptionProfile,
} from '../types/index';
import {
  INITIAL_COUNTRY_RULES,
  INITIAL_TEMPLATES,
  loadDefaultTemplate,
  loadSingboxGatewayTemplate,
  loadDefaultRules,
} from '../storage/default-templates';
import { generateMihomoConfig, nodeToMihomoProxy } from '../core/generators/mihomo-generator';
import { generateSingboxConfig } from '../core/generators/singbox-generator';
import { generateLoonConfig, nodeToLoonProxy } from '../core/generators/loon-generator';
import { generateQuantumultXConfig, nodeToQuantumultXProxy } from '../core/generators/quantumultx-generator';
import { generateEgernConfig, nodeToEgernProxy } from '../core/generators/egern-generator';
import { generateShadowrocketConfig, generateShadowrocketBase64 } from '../core/generators/shadowrocket-generator';
import { detectClientType, ClientType } from '../core/parser/ua-detector';
import { applyExtractionRules } from '../core/filter/extractor';
import { commitSource, refreshSource, SourceUpdateError } from '../services/source-service';
import { UnsupportedProxyGroupError } from '../core/generators/errors';
import {
  ensureCustomSource,
  ensureCustomProxyGroup,
  ensureAllSourceProxyGroups,
  collectNodesFromSources,
  refreshAllSources,
  getEffectiveNodes,
  getEffectiveNodesForProfile,
  getEffectiveGroupsForProfile,
  getEffectiveSourcesForProfile,
  getEffectiveRulesForProfile,
  getEffectiveTemplateForProfile,
} from '../services/profile-service';

export const apiRouter = new Hono<BodyEnv>({ strict: false });

// 1. Config & Settings
apiRouter.get('/config', (c) => {
  return c.json({ success: true, data: appConfig });
});


apiRouter.post('/config/settings', (c) => {
  const body = c.get('body');
  const { settings } = body;
  if (settings) {
    appConfig.settings = { ...appConfig.settings, ...settings };
    ensureCustomSource(appConfig);
    ensureCustomProxyGroup(appConfig);
    ensureAllSourceProxyGroups(appConfig);
    saveConfig(appConfig);
  }
  return c.json({ success: true, data: appConfig.settings, proxyGroups: appConfig.proxyGroups });
});

// 2. Custom Nodes Management (独立节点组专区)
apiRouter.get('/custom-nodes', (c) => {
  const sourceId = c.req.query('sourceId') as string | undefined;
  if (sourceId) {
    const target = appConfig.sources.find(s => s.id === sourceId && (s.type === 'custom' || s.type === 'manual' || s.id === 'custom' || !s.url));
    return c.json({ success: true, count: target?.nodes?.length || 0, data: target?.nodes || [] });
  }
  const customSrc = ensureCustomSource(appConfig);
  return c.json({ success: true, count: customSrc?.nodes?.length || 0, data: customSrc?.nodes || [] });
});

apiRouter.post('/custom-nodes/import', (c) => {
  const body = c.get('body');
  const { text, replaceAll, sourceId } = body;
  if (text === undefined || typeof text !== 'string') {
    return c.json({ success: false, message: 'Text content required' }, 400);
  }

  // Find target custom source
  let targetSrc = sourceId
    ? appConfig.sources.find(s => s.id === sourceId && (s.type === 'custom' || s.type === 'manual' || s.id === 'custom' || !s.url))
    : null;
  if (!targetSrc) {
    targetSrc = ensureCustomSource(appConfig);
  }
  if (!targetSrc) {
    return c.json({ success: false, message: '请先创建一个独立节点组' }, 404);
  }

  if (replaceAll && !text.trim()) {
    targetSrc.nodes = [];
    targetSrc.nodeCount = 0;
    targetSrc.lastUpdated = new Date().toISOString();
    ensureCustomProxyGroup(appConfig);
    saveConfig(appConfig);
    setGlobalNodesCache(collectNodesFromSources(appConfig));

    return c.json({
      success: true,
      count: 0,
      added: 0,
      data: [],
      sourceId: targetSrc.id,
      proxyGroups: appConfig.proxyGroups,
    });
  }

  const parsedNodes: ProxyNode[] = parseRawContent(text, targetSrc.id, targetSrc.name, undefined, appConfig.countryRules);

  if (parsedNodes.length === 0) {
    return c.json({ success: false, message: '未能从粘贴文本中识别到有效节点 (支持 URI 链接, Clash YAML, Singbox JSON, Base64)' }, 400);
  }

  if (replaceAll) {
    targetSrc.nodes = parsedNodes;
  } else {
    const existingIds = new Set((targetSrc.nodes || []).map(n => `${n.server}:${n.port}:${n.name}`));
    const newOnes = parsedNodes.filter(n => !existingIds.has(`${n.server}:${n.port}:${n.name}`));
    targetSrc.nodes = [...(targetSrc.nodes || []), ...newOnes];
  }

  targetSrc.nodeCount = targetSrc.nodes.length;
  targetSrc.lastUpdated = new Date().toISOString();
  ensureCustomProxyGroup(appConfig);
  saveConfig(appConfig);
  setGlobalNodesCache(collectNodesFromSources(appConfig));

  return c.json({
    success: true,
    count: targetSrc.nodes.length,
    added: parsedNodes.length,
    data: targetSrc.nodes,
    sourceId: targetSrc.id,
    proxyGroups: appConfig.proxyGroups,
  });
});

apiRouter.post('/custom-nodes', (c) => {
  const body = c.get('body');
  let targetSrc = body.sourceId
    ? appConfig.sources.find(s => s.id === body.sourceId && (s.type === 'custom' || s.type === 'manual' || s.id === 'custom' || !s.url))
    : null;
  if (!targetSrc) {
    targetSrc = ensureCustomSource(appConfig);
  }
  if (!targetSrc) {
    return c.json({ success: false, message: '请先创建一个独立节点组' }, 404);
  }

  const newNode: ProxyNode = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sourceId: targetSrc.id,
    sourceName: targetSrc.name,
    name: body.name || '独立节点',
    type: body.type || 'vless',
    server: body.server || '',
    port: Number(body.port) || 443,
    countryCode: body.countryCode || 'OTHER',
    countryEmoji: body.countryEmoji || '🌐',
    ...body,
  };
  if (!newNode.detour) {
    delete newNode.detour;
  }

  targetSrc.nodes = [...(targetSrc.nodes || []), newNode];
  targetSrc.nodeCount = targetSrc.nodes.length;
  ensureCustomProxyGroup(appConfig);
  saveConfig(appConfig);
  setGlobalNodesCache(collectNodesFromSources(appConfig));

  return c.json({
    success: true,
    data: newNode,
    count: targetSrc.nodes.length,
    sourceId: targetSrc.id,
    proxyGroups: appConfig.proxyGroups,
  });
});

const updateNodeHandler: Handler<BodyEnv, '/:id'> = (c) => {
  const body = c.get('body');
  const { name, text, rawContent, raw, detour, ...directFields } = body || {};
  const configText = (typeof text === 'string' ? text : typeof rawContent === 'string' ? rawContent : typeof raw === 'string' ? raw : '').trim();

  for (const s of appConfig.sources) {
    if (s.nodes) {
      const idx = s.nodes.findIndex(n => n.id === c.req.param('id'));
      if (idx !== -1) {
        let updatedNode: ProxyNode = { ...s.nodes[idx], ...directFields };

        // If configText is provided, parse it to extract protocol, server, port, security, etc.
        if (configText) {
          try {
            const parsed = parseRawContent(configText, s.id, s.name, undefined, appConfig.countryRules);
            if (parsed.length > 0) {
              const newParsed = parsed[0];
              updatedNode = {
                ...s.nodes[idx],
                ...newParsed,
                id: c.req.param('id'), // Preserve original unique node ID
                sourceId: s.id,
                sourceName: s.name,
                raw: configText,
                ...directFields,
              };
            } else {
              updatedNode.raw = configText;
            }
          } catch (err: any) {
            console.warn(`[NodeUpdate] Failed to parse config text for node ${c.req.param('id')}:`, err.message);
            updatedNode.raw = configText;
          }
        }

        // If a new name is explicitly provided
        if (name && typeof name === 'string' && name.trim()) {
          updatedNode.name = name.trim();
        }

        // Explicitly handle detour
        if ('detour' in body) {
          const detourVal = typeof detour === 'string' ? detour.trim() : '';
          if (detourVal) {
            updatedNode.detour = detourVal;
            if (typeof updatedNode.raw === 'object' && updatedNode.raw !== null) {
              updatedNode.raw.detour = detourVal;
            }
          } else {
            delete updatedNode.detour;
            if (typeof updatedNode.raw === 'object' && updatedNode.raw !== null) {
              delete updatedNode.raw.detour;
            }
          }
        }

        s.nodes[idx] = updatedNode;
        saveConfig(appConfig);
        setGlobalNodesCache(collectNodesFromSources(appConfig));
        return c.json({ success: true, data: s.nodes[idx] });
      }
    }
  }
  return c.json({ success: false, message: 'Node not found' }, 404);
};

apiRouter.put('/custom-nodes/:id', updateNodeHandler);
apiRouter.put('/nodes/:id', updateNodeHandler);

const deleteNodeHandler: Handler<BodyEnv, '/:id'> = (c) => {
  const nodeId = c.req.param('id');
  let deleted = false;
  let remainingCount = 0;
  let affectedNodes: ProxyNode[] = [];

  for (const s of appConfig.sources) {
    if (s.nodes && s.nodes.length > 0) {
      const idx = s.nodes.findIndex(n => n.id === nodeId);
      if (idx !== -1) {
        s.nodes.splice(idx, 1);
        s.nodeCount = s.nodes.length;
        deleted = true;
        remainingCount = s.nodeCount;
        affectedNodes = s.nodes;
        break;
      }
    }
  }

  if (deleted) {
    saveConfig(appConfig);
    setGlobalNodesCache(collectNodesFromSources(appConfig));
    return c.json({ success: true, count: remainingCount, data: affectedNodes, message: 'Node deleted' });
  }

  return c.json({ success: false, message: 'Node not found' }, 404);
};

apiRouter.delete('/custom-nodes/:id', deleteNodeHandler);
apiRouter.delete('/nodes/:id', deleteNodeHandler);

apiRouter.post('/sources/:id/clear-nodes', (c) => {
  const source = appConfig.sources.find(s => s.id === c.req.param('id'));
  if (!source) {
    return c.json({ success: false, message: 'Source not found' }, 404);
  }
  source.nodes = [];
  source.nodeCount = 0;
  source.lastUpdated = new Date().toISOString();
  saveConfig(appConfig);
  setGlobalNodesCache(collectNodesFromSources(appConfig));
  return c.json({ success: true, message: 'Nodes cleared' });
});

// 3. Network Sources Management (网络订阅源与自建节点组)
apiRouter.get('/sources', (c) => c.json({ success: true, data: appConfig.sources }));

apiRouter.get('/sources/:id/raw', (c) => {
  const source = appConfig.sources.find(s => s.id === c.req.param('id'));
  if (!source?.rawSubscription) return c.json({ success: false, message: '订阅原文不存在' }, 404);
  return c.json({ success: true, data: { ...source.rawSubscription, lastSuccessfulUpdate: source.lastUpdated } });
});

apiRouter.post('/sources', async (c) => {
  const body = c.get('body');
  try {
    if (['manual', 'custom'].includes(body.type)) return c.json({ success: false, message: '节点必须来自上游订阅' }, 400);
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!/^https?:\/\//.test(url)) return c.json({ success: false, message: '请填写 HTTP 订阅链接' }, 400);
    try { validateInfoRegex(body); } catch (error: any) { return c.json({ success: false, message: error.message }, 400); }
    const source: SubscriptionSource = {
      id: `src-${crypto.randomUUID()}`, name: (body.name || '新订阅').trim(), url,
      enabled: body.enabled !== false, type: body.type || 'auto',
      trafficNodeRegex: body.trafficNodeRegex?.trim(), expiryNodeRegex: body.expiryNodeRegex?.trim(),
    };
    try {
      source.nodes = await fetchAndParseSource(source, appConfig.countryRules);
    } catch (error: any) { return c.json({ success: false, message: error.message || '上游更新失败' }, 422); }
    source.nodeCount = source.nodes.length;
    const candidate = structuredClone(appConfig);
    candidate.sources.push(source);
    if (body.createGroup) candidate.proxyGroups.push({
      id: `grp-${source.id}`, name: source.name, type: 'urltest', sources: [source.id],
      tolerance: 50, interval: 300, url: 'https://www.google.com/generate_204',
    });
    saveConfig(candidate);
    setAppConfig(candidate);
    setGlobalNodesCache(collectNodesFromSources(candidate));
    return c.json({ success: true, count: source.nodeCount, data: source });
  } catch (error: any) { return c.json({ success: false, message: error.message || '保存失败' }, 500); }
});

apiRouter.put('/sources/:id', async (c) => {
  const body = c.get('body');
  const current = appConfig.sources.find(s => s.id === c.req.param('id'));
  if (!current) return c.json({ success: false, message: 'Source not found' }, 404);
  try { validateInfoRegex(body); } catch (error: any) { return c.json({ success: false, message: error.message }, 400); }
  if (['manual', 'custom'].includes(body.type)) return c.json({ success: false, message: '节点必须来自上游订阅' }, 400);
  if (body.url !== undefined && (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url.trim()))) return c.json({ success: false, message: '请填写 HTTP 订阅链接' }, 400);
  const candidate = structuredClone(current);
  if (typeof body.name === 'string' && body.name.trim()) candidate.name = cleanSourceOrGroupName(body.name.trim());
  if (typeof body.url === 'string') candidate.url = body.url.trim();
  if (typeof body.type === 'string') candidate.type = body.type;
  if (typeof body.enabled === 'boolean') candidate.enabled = body.enabled;
  if (typeof body.customUserAgent === 'string') candidate.customUserAgent = body.customUserAgent.trim();
  if (typeof body.trafficNodeRegex === 'string') candidate.trafficNodeRegex = body.trafficNodeRegex.trim();
  if (typeof body.expiryNodeRegex === 'string') candidate.expiryNodeRegex = body.expiryNodeRegex.trim();
  try {
    let updated: SubscriptionSource;
    if (candidate.url !== current.url || candidate.type !== current.type || candidate.customUserAgent !== current.customUserAgent) {
      updated = await refreshSource(current.id, candidate);
    } else {
      candidate.nodes = applySubscriptionInfo(candidate, [...(candidate.nodes || []), ...(candidate.infoNodes || [])]);
      candidate.nodeCount = candidate.nodes.length;
      [...candidate.nodes, ...(candidate.infoNodes || [])].forEach(node => { node.sourceName = candidate.name; });
      commitSource(candidate);
      updated = candidate;
    }
    return c.json({ success: true, data: updated, proxyGroups: appConfig.proxyGroups });
  } catch (error: any) {
    return c.json({ success: false, message: error.message || '保存失败' }, error instanceof SourceUpdateError ? error.status : 500);
  }
});

apiRouter.delete('/sources/:id', (c) => {
  if (c.req.param('id') === 'custom') {
    return c.json({ success: false, message: '默认独立节点组不能删除，可清空组内节点' }, 400);
  }
  const deletedSource = appConfig.sources.find(s => s.id === c.req.param('id'));
  appConfig.sources = appConfig.sources.filter(s => s.id !== c.req.param('id'));

  if (deletedSource) {
    const sClean = cleanSourceOrGroupName(deletedSource.name).toLowerCase();
    const sId = (deletedSource.id || '').trim().toLowerCase();
    const sRaw = (deletedSource.name || '').trim().toLowerCase();

    const matchesSource = (target: string) => {
      if (!target) return false;
      const t = target.trim().toLowerCase();
      const tClean = cleanSourceOrGroupName(target).toLowerCase();
      return t === sId || t === sRaw || tClean === sClean || tClean === sId;
    };

    appConfig.proxyGroups = (appConfig.proxyGroups || []).filter(g => 
      g.id !== `grp-src-${deletedSource.id}` && !matchesSource(g.name)
    );
    appConfig.proxyGroups.forEach(grp => {
      if (grp.use) grp.use = grp.use.filter(u => !matchesSource(u));
      if (grp.sources) grp.sources = grp.sources.filter(s => !matchesSource(s));
      if (grp.proxies) grp.proxies = grp.proxies.filter(p => !matchesSource(p));
    });

    // Clean up sourceIds references in profiles
    (appConfig.profiles || []).forEach(p => {
      if (p.nodeFilter?.sourceIds) {
        p.nodeFilter.sourceIds = p.nodeFilter.sourceIds.filter(id => id !== c.req.param('id') && !matchesSource(id));
      }
    });
  }

  saveConfig(appConfig);
  setGlobalNodesCache(collectNodesFromSources(appConfig));
  return c.json({ success: true, message: 'Source deleted' });
});

apiRouter.post('/sources/:id/refresh', async (c) => {
  if (!appConfig.sources.some(s => s.id === c.req.param('id'))) return c.json({ success: false, message: 'Source not found' }, 404);
  try {
    const source = await refreshSource(c.req.param('id'));
    return c.json({ success: true, nodeCount: source.nodeCount, data: source.nodes, source });
  } catch (error: any) {
    return c.json({ success: false, message: error.message || 'Fetch failed' }, error instanceof SourceUpdateError ? error.status : 500);
  }
});

apiRouter.post('/sources/refresh-all', async (c) => {
  try {
    const { nodes: all, results } = await refreshAllSources(appConfig);
    const effective = applyExtractionRules(all, appConfig.rules);
    return c.json({ success: results.every(result => result.success), results, totalNodes: all.length, effectiveNodes: effective.length });
  } catch (err: any) {
    return c.json({ success: false, message: err.message || 'Refresh all failed' }, 500);
  }
});


// 3. Country Matching & Grouping Rules (国家/地区识别规则)
apiRouter.get('/country-rules', (c) => {
  return c.json({ success: true, data: appConfig.countryRules || INITIAL_COUNTRY_RULES });
});

apiRouter.post('/country-rules', (c) => {
  const body = c.get('body');
  const newRule: CountryPatternRule = {
    id: `c-${Date.now()}`,
    code: (body.code || 'OTHER').toUpperCase(),
    name: body.name || '自定义地区',
    emoji: body.emoji || '🌐',
    pattern: body.pattern || '',
    groupName: body.groupName,
  };
  if (!appConfig.countryRules) appConfig.countryRules = [...INITIAL_COUNTRY_RULES];
  appConfig.countryRules.push(newRule);
  saveConfig(appConfig);
  return c.json({ success: true, data: newRule });
});

apiRouter.put('/country-rules/:id', (c) => {
  const body = c.get('body');
  if (!appConfig.countryRules) appConfig.countryRules = [...INITIAL_COUNTRY_RULES];
  const idx = appConfig.countryRules.findIndex(r => r.id === c.req.param('id'));
  if (idx === -1) return c.json({ success: false, message: 'Country rule not found' }, 404);
  appConfig.countryRules[idx] = { ...appConfig.countryRules[idx], ...body };
  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.countryRules[idx] });
});

apiRouter.delete('/country-rules/:id', (c) => {
  if (!appConfig.countryRules) appConfig.countryRules = [...INITIAL_COUNTRY_RULES];
  appConfig.countryRules = appConfig.countryRules.filter(r => r.id !== c.req.param('id'));
  saveConfig(appConfig);
  return c.json({ success: true, message: 'Country rule deleted' });
});

apiRouter.post('/country-rules/reset', (c) => {
  appConfig.countryRules = [...INITIAL_COUNTRY_RULES];
  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.countryRules });
});

// 4. Extraction & Rename Rules (节点抽取与清洗流水线)
apiRouter.get('/rules', (c) => {
  return c.json({ success: true, data: appConfig.rules });
});

apiRouter.post('/rules', (c) => {
  const body = c.get('body');
  const newRule = {
    id: `rule-${Date.now()}`,
    name: body.name || '新抽取规则',
    enabled: body.enabled !== false,
    ...body,
  };
  appConfig.rules.push(newRule);
  saveConfig(appConfig);
  return c.json({ success: true, data: newRule });
});

apiRouter.put('/rules/:id', (c) => {
  const body = c.get('body');
  const index = appConfig.rules.findIndex(r => r.id === c.req.param('id'));
  if (index === -1) {
    return c.json({ success: false, message: 'Rule not found' }, 404);
  }
  appConfig.rules[index] = { ...appConfig.rules[index], ...body };
  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.rules[index] });
});

apiRouter.delete('/rules/:id', (c) => {
  appConfig.rules = appConfig.rules.filter(r => r.id !== c.req.param('id'));
  saveConfig(appConfig);
  return c.json({ success: true, message: 'Rule deleted' });
});

// 4. Effective Nodes
apiRouter.get('/nodes', async (c) => {
  try {
    const effective = await getEffectiveNodes();
    return c.json({ success: true, totalCount: effective.length, data: effective });
  } catch (err: any) {
    return c.json({ success: false, message: err.message }, 500);
  }
});

export function sanitizeProxyGroups(appConfig: AppConfig): boolean {
  let changed = false;
  const validSourceSet = new Set<string>();
  (appConfig.sources || []).forEach(s => {
    if (s.id) validSourceSet.add(s.id.trim().toLowerCase());
    if (s.name) {
      validSourceSet.add(s.name.trim().toLowerCase());
      validSourceSet.add(cleanSourceOrGroupName(s.name).toLowerCase());
    }
  });

  (appConfig.proxyGroups || []).forEach(g => {
    if (Array.isArray(g.sources) && g.sources.length > 0) {
      const filtered = g.sources.filter(s => {
        const raw = (s || '').trim().toLowerCase();
        const clean = cleanSourceOrGroupName(s).toLowerCase();
        return validSourceSet.has(raw) || validSourceSet.has(clean);
      });
      if (filtered.length !== g.sources.length) {
        g.sources = filtered;
        changed = true;
      }
    }
    if (Array.isArray(g.use) && g.use.length > 0) {
      const filtered = g.use.filter(u => {
        const raw = (u || '').trim().toLowerCase();
        const clean = cleanSourceOrGroupName(u).toLowerCase();
        return validSourceSet.has(raw) || validSourceSet.has(clean);
      });
      if (filtered.length !== g.use.length) {
        g.use = filtered;
        changed = true;
      }
    }
  });

  return changed;
}

// 5. Proxy Groups Management (出口策略分组)
apiRouter.get('/groups', (c) => {
  let needSave = ensureCustomProxyGroup(appConfig);
  if (sanitizeProxyGroups(appConfig)) {
    needSave = true;
  }
  if (needSave) {
    saveConfig(appConfig);
  }
  return c.json({ success: true, data: appConfig.proxyGroups });
});

apiRouter.post('/groups', (c) => {
  const body = c.get('body');
  const newGroup: ProxyGroupItem = {
    id: `grp-${Date.now()}`,
    name: body.name || '新分组',
    type: body.type || 'select',
    proxies: body.proxies || [],
    use: body.use,
    filter: body.filter,
    tolerance: body.tolerance,
    interval: body.interval,
    url: body.url,
    includeAll: body.includeAll,
    strategy: body.strategy,
    lazy: body.lazy,
    hidden: body.hidden,
    icon: body.icon,
  };
  appConfig.proxyGroups.push(newGroup);
  saveConfig(appConfig);
  return c.json({ success: true, data: newGroup });
});

apiRouter.post('/groups/batch-import', (c) => {
  const body = c.get('body');
  const { text, replaceAll } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ success: false, message: 'Text required' }, 400);
  }
  const parsed = parseProxyGroupsText(text);
  if (parsed.length === 0) {
    return c.json({ success: false, message: '未能从粘贴内容中识别到策略组' }, 400);
  }

  if (replaceAll) {
    appConfig.proxyGroups = parsed;
  } else {
    // Merge by unique name
    const existingNames = new Set(appConfig.proxyGroups.map(g => g.name));
    parsed.forEach(p => {
      if (!existingNames.has(p.name)) {
        appConfig.proxyGroups.push(p);
      }
    });
  }

  saveConfig(appConfig);
  return c.json({ success: true, count: parsed.length, data: appConfig.proxyGroups });
});

apiRouter.post('/groups/generate-country-presets', (c) => {
  const countryRules = appConfig.countryRules || INITIAL_COUNTRY_RULES;
  const existingNames = new Set(appConfig.proxyGroups.map(g => g.name));
  const newGroups: ProxyGroupItem[] = [];

  // 1. Generate dedicated group for each active subscription source (including custom nodes if non-empty)
  appConfig.sources.forEach(src => {
    const srcName = (src.name || '').trim();
    if (!srcName) return;
    if ((src.id === 'custom' || src.type === 'custom') && (!src.nodes || src.nodes.length === 0)) return;
    const groupTag = `⚡️ ${srcName}`;
    if (!existingNames.has(groupTag) && !existingNames.has(srcName)) {
      const srcGroup: ProxyGroupItem = {
        id: `grp-src-${Date.now()}-${src.id}`,
        name: groupTag,
        type: (src.id === 'custom' || src.type === 'custom' || src.type === 'manual') ? 'select' : 'urltest',
        sources: [src.id],
        use: [srcName],
        tolerance: 50,
        interval: 300,
        url: 'https://www.google.com/generate_204',
      };
      appConfig.proxyGroups.push(srcGroup);
      existingNames.add(groupTag);
      newGroups.push(srcGroup);
    }
  });

  // 2. Generate country preset groups
  countryRules.forEach(cr => {
    const groupName = cr.groupName || `${cr.emoji} ${cr.name}节点`;
    if (!existingNames.has(groupName)) {
      const newGrp: ProxyGroupItem = {
        id: `grp-${cr.code.toLowerCase()}-${Date.now()}`,
        name: groupName,
        type: 'urltest',
        filter: cr.pattern,
        tolerance: 50,
        isCountryGroup: true,
      };
      appConfig.proxyGroups.push(newGrp);
      existingNames.add(groupName);
      newGroups.push(newGrp);
    }
  });

  saveConfig(appConfig);
  return c.json({ success: true, count: newGroups.length, data: appConfig.proxyGroups });
});

apiRouter.put('/groups/:id', (c) => {
  const body = c.get('body');
  const idx = appConfig.proxyGroups.findIndex(g => g.id === c.req.param('id'));
  if (idx === -1) return c.json({ success: false, message: 'Group not found' }, 404);
  
  const current = appConfig.proxyGroups[idx];
  const updated = { ...current, ...body };

  // Explicitly handle clearing fields if provided
  if ('proxies' in body) {
    if (Array.isArray(body.proxies) && body.proxies.length > 0) {
      updated.proxies = body.proxies;
    } else {
      delete updated.proxies;
    }
  }

  if ('use' in body) {
    if (Array.isArray(body.use) && body.use.length > 0) {
      updated.use = body.use;
    } else {
      delete updated.use;
    }
  }

  if ('filter' in body) {
    if (typeof body.filter === 'string' && body.filter.trim()) {
      updated.filter = body.filter.trim();
    } else {
      delete updated.filter;
    }
  }

  appConfig.proxyGroups[idx] = updated;
  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.proxyGroups[idx] });
});

apiRouter.delete('/groups/:id', (c) => {
  appConfig.proxyGroups = appConfig.proxyGroups.filter(g => g.id !== c.req.param('id'));
  saveConfig(appConfig);
  return c.json({ success: true, message: 'Group deleted' });
});


// 6. Unified Rules Matrix Management (表格化规则与去向管理)
apiRouter.get('/rules/unified', (c) => {
  return c.json({ success: true, data: appConfig.rulesList });
});

apiRouter.post('/rules/unified', (c) => {
  const body = c.get('body');
  const newRule: UnifiedRuleItem = {
    id: `r-${Date.now()}`,
    name: body.name || '新规则',
    kind: body.kind || 'local',
    type: body.type || 'DOMAIN-SUFFIX',
    payload: body.payload || '',
    format: body.format,
    outbound: body.outbound || (appConfig.proxyGroups[0]?.name || '🎯 本地直连'),
    enabled: body.enabled !== false,
  };
  appConfig.rulesList.push(newRule);
  saveConfig(appConfig);
  return c.json({ success: true, data: newRule });
});

apiRouter.post('/rules/import-local', (c) => {
  const body = c.get('body');
  const { text, defaultOutbound } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ success: false, message: 'Text required' }, 400);
  }
  const outbound = defaultOutbound || appConfig.proxyGroups[0]?.name || '🎯 本地直连';
  const parsed = parseLocalRulesText(text, outbound);
  if (parsed.length === 0) {
    return c.json({ success: false, message: '未能从粘贴内容中识别到本地规则' }, 400);
  }

  appConfig.rulesList.push(...parsed);
  saveConfig(appConfig);
  return c.json({ success: true, count: parsed.length, data: appConfig.rulesList });
});

apiRouter.post('/rules/import-remote', (c) => {
  const body = c.get('body');
  const { text, defaultOutbound } = body;
  if (!text || typeof text !== 'string') {
    return c.json({ success: false, message: 'Text required' }, 400);
  }
  const outbound = defaultOutbound || appConfig.proxyGroups[0]?.name || '🚀 节点选择';
  const parsed = parseRemoteRulesText(text, outbound);
  if (parsed.length === 0) {
    return c.json({ success: false, message: '未能从粘贴内容中识别到远程规则集' }, 400);
  }

  appConfig.rulesList.push(...parsed);
  saveConfig(appConfig);
  return c.json({ success: true, count: parsed.length, data: appConfig.rulesList });
});

apiRouter.put('/rules/unified/:id', (c) => {
  const body = c.get('body');
  const idx = appConfig.rulesList.findIndex(r => r.id === c.req.param('id'));
  if (idx === -1) return c.json({ success: false, message: 'Rule not found' }, 404);
  appConfig.rulesList[idx] = { ...appConfig.rulesList[idx], ...body };
  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.rulesList[idx] });
});

apiRouter.delete('/rules/unified/:id', (c) => {
  appConfig.rulesList = appConfig.rulesList.filter(r => r.id !== c.req.param('id'));
  saveConfig(appConfig);
  return c.json({ success: true, message: 'Rule deleted' });
});

apiRouter.post('/rules/unified/clear-all', (c) => {
  appConfig.rulesList = [];
  saveConfig(appConfig);
  return c.json({ success: true, message: 'All rules cleared' });
});

apiRouter.post('/rules/unified/reset', (c) => {
  const defaultRules = loadDefaultRules();
  appConfig.rulesList = defaultRules;
  saveConfig(appConfig);
  return c.json({ success: true, count: defaultRules.length, data: appConfig.rulesList });
});

apiRouter.get('/rules/unified/defaults', (c) => {
  const defaultRules = loadDefaultRules();
  return c.json({ success: true, count: defaultRules.length, data: defaultRules });
});

apiRouter.get('/rules/unified/export-text', (c) => {
  const text = exportRulesToText(appConfig.rulesList);
  return c.json({ success: true, text });
});

apiRouter.post('/rules/unified/batch-replace', (c) => {
  const body = c.get('body');
  const { text, defaultOutbound } = body;
  if (typeof text !== 'string') {
    return c.json({ success: false, message: 'Text required' }, 400);
  }
  const outbound = defaultOutbound || appConfig.proxyGroups[0]?.name || '🎯 本地直连';
  const parsed = parseUnifiedRulesText(text, outbound);

  // Built-in core actions that should never be auto-registered as proxy groups
  const BUILTIN_OUTBOUNDS = new Set([
    'reject', 'direct', 'global', 'pass', 'block', 'drop',
    'reject-drop', 'no-resolve', 'match', 'final',
  ]);

  // Automatically register any newly referenced custom outbound groups
  const existingGroupNames = new Set(appConfig.proxyGroups.map(g => g.name.toLowerCase()));
  parsed.forEach(r => {
    const ob = (r.outbound || '').trim();
    if (ob && !BUILTIN_OUTBOUNDS.has(ob.toLowerCase()) && !existingGroupNames.has(ob.toLowerCase())) {
      existingGroupNames.add(ob.toLowerCase());
      appConfig.proxyGroups.push({
        id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: r.outbound,
        type: 'select',
        proxies: ['🚀 节点选择', '🎯 本地直连'],
      });
    }
  });

  appConfig.rulesList = parsed;
  saveConfig(appConfig);
  return c.json({ success: true, count: parsed.length, data: appConfig.rulesList, groups: appConfig.proxyGroups });
});

// 7. Multi-Templates Management
apiRouter.get('/templates', (c) => {
  return c.json({ success: true, data: appConfig.templates });
});

apiRouter.get('/templates/defaults', (c) => {
  const defaults: Record<string, string> = {
    singbox: loadDefaultTemplate('singbox'),
    'singbox-gateway': loadSingboxGatewayTemplate(),
    mihomo: loadDefaultTemplate('mihomo'),
    loon: loadDefaultTemplate('loon'),
    quantumultx: loadDefaultTemplate('quantumultx'),
    egern: loadDefaultTemplate('egern'),
    shadowrocket: loadDefaultTemplate('shadowrocket'),
  };
  return c.json({ success: true, data: defaults });
});

apiRouter.get('/templates/default/:type', (c) => {
  const type = c.req.param('type');
  if (type === 'singbox-gateway') {
    const content = loadSingboxGatewayTemplate();
    return c.json({ success: true, type, content });
  }
  const content = loadDefaultTemplate(type as ClientType);
  return c.json({ success: true, type, content });
});

apiRouter.post('/templates', (c) => {
  const body = c.get('body');
  const type: ClientType = body.type || 'singbox';
  let content = body.content;
  if (!content || !content.trim() || content.trim() === '# 模版内容') {
    content = loadDefaultTemplate(type);
  }
  const newTemplate: ConfigTemplate = {
    id: `tpl-${Date.now()}`,
    name: body.name || `新建${type}配置模版`,
    type,
    content,
    description: body.description || '',
    isDefault: Boolean(body.isDefault),
  };
  if (newTemplate.isDefault) {
    appConfig.templates.forEach(t => {
      if (t.type === newTemplate.type) t.isDefault = false;
    });
  }
  appConfig.templates.push(newTemplate);
  saveConfig(appConfig);
  return c.json({ success: true, data: newTemplate });
});

apiRouter.put('/templates/:id', (c) => {
  const body = c.get('body');
  const index = appConfig.templates.findIndex(t => t.id === c.req.param('id'));
  if (index === -1) {
    return c.json({ success: false, message: 'Template not found' }, 404);
  }
  const updated = { ...appConfig.templates[index], ...body };
  if (updated.isDefault) {
    appConfig.templates.forEach(t => {
      if (t.type === updated.type && t.id !== updated.id) t.isDefault = false;
    });
  }
  appConfig.templates[index] = updated;
  saveConfig(appConfig);
  return c.json({ success: true, data: updated });
});

apiRouter.post('/templates/:id/reset', (c) => {
  const index = appConfig.templates.findIndex(t => t.id === c.req.param('id'));
  if (index === -1) {
    return c.json({ success: false, message: '模版未找到' }, 404);
  }
  const tpl = appConfig.templates[index];
  if (tpl.id === 'tpl-singbox-gateway' || tpl.name.includes('旁路由') || tpl.name.includes('网关')) {
    tpl.content = loadSingboxGatewayTemplate();
  } else {
    tpl.content = loadDefaultTemplate(tpl.type);
  }
  appConfig.templates[index] = tpl;
  saveConfig(appConfig);
  return c.json({ success: true, data: tpl });
});

apiRouter.delete('/templates/:id', (c) => {
  if (appConfig.templates.length <= 1) {
    return c.json({ success: false, message: '至少保留一个模版' }, 400);
  }
  appConfig.templates = appConfig.templates.filter(t => t.id !== c.req.param('id'));
  saveConfig(appConfig);
  return c.json({ success: true, message: 'Template deleted' });
});

// 7. Profiles Management (多订阅中心)
apiRouter.get('/profiles', (c) => {
  return c.json({ success: true, data: appConfig.profiles || [] });
});


apiRouter.post('/profiles', (c) => {
  const body = c.get('body');
  const { name, description, nodeFilter, selectedGroupIds, selectedRuleIds, templates, token } = body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return c.json({ success: false, message: '订阅名称不能为空' }, 400);
  }

  const newProfile: SubscriptionProfile = {
    id: `prof_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: name.trim(),
    token: typeof token === 'string' && token.trim() ? token.trim() : generateRandomSubToken(),
    enabled: true,
    description: description?.trim(),
    nodeFilter: nodeFilter || { mode: 'all', selectedNodeIds: [] },
    selectedGroupIds: Array.isArray(selectedGroupIds) ? selectedGroupIds : [],
    selectedRuleIds: Array.isArray(selectedRuleIds) ? selectedRuleIds : [],
    templates: templates || {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  appConfig.profiles = appConfig.profiles || [];
  appConfig.profiles.push(newProfile);
  saveConfig(appConfig);
  return c.json({ success: true, data: newProfile });
});

apiRouter.put('/profiles/:id', (c) => {
  const body = c.get('body');
  const { id } = c.req.param();
  const index = (appConfig.profiles || []).findIndex(p => p.id === id);
  if (index === -1) {
    return c.json({ success: false, message: 'Profile not found' }, 404);
  }

  const existing = appConfig.profiles[index];
  const { name, description, enabled, nodeFilter, selectedGroupIds, selectedRuleIds, templates, token } = body;

  appConfig.profiles[index] = {
    ...existing,
    name: typeof name === 'string' && name.trim() ? name.trim() : existing.name,
    description: description !== undefined ? description : existing.description,
    enabled: enabled !== undefined ? Boolean(enabled) : existing.enabled,
    nodeFilter: nodeFilter !== undefined ? nodeFilter : existing.nodeFilter,
    selectedGroupIds: Array.isArray(selectedGroupIds) ? selectedGroupIds : existing.selectedGroupIds,
    selectedRuleIds: Array.isArray(selectedRuleIds) ? selectedRuleIds : existing.selectedRuleIds,
    templates: templates !== undefined ? templates : existing.templates,
    token: typeof token === 'string' && token.trim() ? token.trim() : existing.token,
    updatedAt: new Date().toISOString(),
  };

  saveConfig(appConfig);
  return c.json({ success: true, data: appConfig.profiles[index] });
});

apiRouter.delete('/profiles/:id', (c) => {
  const { id } = c.req.param();
  if (!appConfig.profiles || appConfig.profiles.length <= 1) {
    return c.json({ success: false, message: '请至少保留一个订阅配置' }, 400);
  }
  appConfig.profiles = appConfig.profiles.filter(p => p.id !== id);
  saveConfig(appConfig);
  return c.json({ success: true, message: '订阅已删除' });
});

apiRouter.post('/profiles/:id/refresh-token', (c) => {
  const { id } = c.req.param();
  const profile = (appConfig.profiles || []).find(p => p.id === id);
  if (!profile) {
    return c.json({ success: false, message: 'Profile not found' }, 404);
  }
  profile.token = generateRandomSubToken();
  profile.updatedAt = new Date().toISOString();
  saveConfig(appConfig);
  return c.json({ success: true, data: profile });
});

// 8. Live Preview
apiRouter.post('/generate/preview', async (c) => {
  const body = c.get('body');
  try {
    const { templateId, customTemplate, customType, profileId, profile: previewProfile } = body;

    let targetProfile: SubscriptionProfile | undefined;
    if (profileId) {
      targetProfile = (appConfig.profiles || []).find(p => p.id === profileId);
    } else if (previewProfile) {
      targetProfile = previewProfile;
    }

    const nodes = targetProfile
      ? await getEffectiveNodesForProfile(targetProfile)
      : await getEffectiveNodes();

    const groups = targetProfile
      ? getEffectiveGroupsForProfile(targetProfile, nodes)
      : appConfig.proxyGroups;

    const rules = targetProfile
      ? getEffectiveRulesForProfile(targetProfile)
      : appConfig.rulesList;

    let targetType: ClientType = customType || 'singbox';
    let templateContent = customTemplate;

    if (templateId) {
      const found = appConfig.templates.find(t => t.id === templateId);
      if (found) {
        targetType = found.type;
        if (!templateContent) templateContent = found.content;
      }
    } else if (targetProfile) {
      const tpl = getEffectiveTemplateForProfile(targetProfile, targetType);
      if (tpl && !templateContent) templateContent = tpl.content;
    }

    if (!templateContent) {
      const defaultTpl = appConfig.templates.find(t => t.type === targetType && t.isDefault) || appConfig.templates.find(t => t.type === targetType);
      templateContent = defaultTpl?.content || '';
    }

    const effectiveSources = targetProfile
      ? getEffectiveSourcesForProfile(targetProfile, nodes)
      : appConfig.sources;

    let output = '';
    const baseUrl = getBaseUrl(c.req);
    const subToken = targetProfile?.token || 'preview-token';
    const expand = Boolean(body?.expandNodes || c.req.query('expand') === 'true' || c.req.query('expand') === '1');

    if (targetType === 'mihomo') {
      output = generateMihomoConfig(templateContent, nodes, groups, rules, effectiveSources, {
        expandNodes: expand,
        baseUrl,
        subToken
      });
    } else if (targetType === 'singbox') {
      output = generateSingboxConfig(templateContent, nodes, groups, rules, effectiveSources);
    } else if (targetType === 'loon') {
      output = generateLoonConfig(templateContent, nodes, groups, rules, effectiveSources, {
        expandNodes: expand,
        baseUrl,
        subToken
      });
    } else if (targetType === 'quantumultx') {
      output = generateQuantumultXConfig(templateContent, nodes, groups, rules, effectiveSources, {
        expandNodes: expand,
        baseUrl,
        subToken
      });
    } else if (targetType === 'egern') {
      output = generateEgernConfig(templateContent, nodes, groups, rules, effectiveSources, {
        expandNodes: expand,
        baseUrl,
        subToken
      });
    } else if (targetType === 'shadowrocket') {
      const isBase64 = body?.format === 'base64' || c.req.query('format') === 'base64';
      if (isBase64) {
        output = generateShadowrocketBase64(nodes);
      } else {
        const expandRocket = body?.expandNodes !== false;
        output = generateShadowrocketConfig(templateContent, nodes, groups, rules, effectiveSources, { expandNodes: expandRocket });
      }
    }

    return c.json({ success: true, nodeCount: nodes.length, data: output });
  } catch (err) {
    const status = err instanceof UnsupportedProxyGroupError ? 422 : 500;
    const message = err instanceof Error ? err.message : 'Generation failed';
    return c.json({ success: false, message }, status);
  }
});
