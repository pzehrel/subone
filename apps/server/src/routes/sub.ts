import { Hono, type Context } from 'hono';
import yaml from 'js-yaml';
import { getAppConfig, getBaseUrl } from '../context';
import { detectClientType, ClientType } from '../core/parser/ua-detector';
import { ProxyNode, ConfigTemplate } from '../types/index';
import { applyExtractionRules } from '../core/filter/extractor';
import { generateMihomoConfig, nodeToMihomoProxy } from '../core/generators/mihomo-generator';
import { generateSingboxConfig } from '../core/generators/singbox-generator';
import { generateLoonConfig, nodeToLoonProxy } from '../core/generators/loon-generator';
import { generateQuantumultXConfig, nodeToQuantumultXProxy } from '../core/generators/quantumultx-generator';
import { generateEgernConfig, nodeToEgernProxy } from '../core/generators/egern-generator';
import { generateShadowrocketConfig, generateShadowrocketBase64 } from '../core/generators/shadowrocket-generator';
import { UnsupportedProxyGroupError } from '../core/generators/errors';
import { parseSubscriptionUserinfo } from '../core/parser/subscription-info';
import {
  getEffectiveNodes,
  getEffectiveNodesForProfile,
  getEffectiveGroupsForProfile,
  getEffectiveRulesForProfile,
  getEffectiveSourcesForProfile,
  getEffectiveTemplateForProfile,
} from '../services/profile-service';

export const subRouter = new Hono({ strict: false });

subRouter.get('/s/:subToken/rules/:ruleId/qx', async (c) => {
  const config = getAppConfig();
  const profile = config.profiles?.find(p => p.enabled !== false && p.token === c.req.param('subToken'));
  const rule = profile && getEffectiveRulesForProfile(profile).find(r =>
    r.id === c.req.param('ruleId') && r.enabled && r.kind === 'remote' && r.behavior === 'classical');
  if (!rule) return c.text('404 Not Found', 404);
  try {
    const { getQuantumultXRules } = await import('../services/qx-rules');
    return c.text(await getQuantumultXRules(rule));
  } catch {
    return c.text('Rule set unavailable', 502);
  }
});

async function handlePrivateSubRequest(c: Context, forcedType?: ClientType) {
  const tokenParam = c.req.param('subToken');
  const appConfig = getAppConfig();

  if (typeof tokenParam !== 'string' || !tokenParam) {
    c.header('X-Powered-By', undefined);
    return c.text('404 Not Found', 404);
  }

  // Find profile by token
  const profile = (appConfig.profiles || []).find(p => p.token === tokenParam && p.enabled !== false);
  if (!profile) {
    c.header('X-Powered-By', undefined);
    return c.text('404 Not Found', 404);
  }

  try {
    const queryTarget = (c.req.query('target') as string) || (c.req.query('type') as string) || (c.req.param('target') as string);
    const userAgent = c.req.header('user-agent');
    const detectedType = forcedType || detectClientType(userAgent, queryTarget, 'singbox');

    let tpl: ConfigTemplate | undefined;
    const tplId = c.req.query('template') as string;
    if (tplId) {
      tpl = appConfig.templates.find(t => t.id === tplId || t.name === tplId);
    }
    if (!tpl) {
      tpl = getEffectiveTemplateForProfile(profile, detectedType);
    }

    const templateContent = tpl?.content || '';
    const nodes = await getEffectiveNodesForProfile(profile);
    const groups = getEffectiveGroupsForProfile(profile, nodes);
    const rules = getEffectiveRulesForProfile(profile);
    const sources = getEffectiveSourcesForProfile(profile, nodes);
    const baseUrl = getBaseUrl(c.req);

    if (detectedType === 'mihomo') {
      const expand = c.req.query('expand') === 'true' || c.req.query('expand') === '1' || c.req.query('node_list') === 'true';
      const output = generateMihomoConfig(templateContent, nodes, groups, rules, sources, {
        expandNodes: expand,
        baseUrl,
        subToken: tokenParam
      });
      c.header('Content-Type', 'text/yaml; charset=utf-8');
      c.header('subscription-userinfo', 'upload=0; download=0; total=1073741824000; expire=0');
      return c.body(output);
    }

    if (detectedType === 'singbox') {
      const output = generateSingboxConfig(templateContent, nodes, groups, rules, sources);
      c.header('Content-Type', 'application/json; charset=utf-8');
      return c.body(output);
    }

    if (detectedType === 'loon') {
      const expand = c.req.query('expand') === 'true' || c.req.query('expand') === '1' || c.req.query('node_list') === 'true';
      const output = generateLoonConfig(templateContent, nodes, groups, rules, sources, {
        expandNodes: expand,
        baseUrl,
        subToken: tokenParam
      });
      c.header('Content-Type', 'text/plain; charset=utf-8');
      return c.body(output);
    }

    if (detectedType === 'quantumultx') {
      const expand = c.req.query('expand') === 'true' || c.req.query('expand') === '1' || c.req.query('node_list') === 'true';
      const output = generateQuantumultXConfig(templateContent, nodes, groups, rules, sources, {
        expandNodes: expand,
        baseUrl,
        subToken: tokenParam
      });
      c.header('Content-Type', 'text/plain; charset=utf-8');
      c.header('subscription-userinfo', 'upload=0; download=0; total=1073741824000; expire=0');
      return c.body(output);
    }

    if (detectedType === 'egern') {
      const expand = c.req.query('expand') === 'true' || c.req.query('expand') === '1' || c.req.query('node_list') === 'true';
      const output = generateEgernConfig(templateContent, nodes, groups, rules, sources, {
        expandNodes: expand,
        baseUrl,
        subToken: tokenParam
      });
      c.header('Content-Type', 'text/yaml; charset=utf-8');
      c.header('subscription-userinfo', 'upload=0; download=0; total=1073741824000; expire=0');
      return c.body(output);
    }

    if (detectedType === 'shadowrocket') {
      const isBase64 = c.req.query('format') === 'base64' || c.req.query('format') === 'b64';
      if (isBase64) {
        const output = generateShadowrocketBase64(nodes);
        c.header('Content-Type', 'text/plain; charset=utf-8');
        c.header('subscription-userinfo', 'upload=0; download=0; total=1073741824000; expire=0');
        return c.body(output);
      }
      const expand = c.req.query('expand') !== 'false' && c.req.query('expand') !== '0';
      const output = generateShadowrocketConfig(templateContent, nodes, groups, rules, sources, { expandNodes: expand });
      c.header('Content-Type', 'text/plain; charset=utf-8');
      c.header('subscription-userinfo', 'upload=0; download=0; total=1073741824000; expire=0');
      return c.body(output);
    }

  } catch (err: any) {
    if (err instanceof UnsupportedProxyGroupError) {
      return c.text(err.message, 422);
    }
    console.error('Subscription generation error:', err);
    return c.html(`Generation error: ${err.message || err}`, 500);
  }
}

async function handleSourceSubRequest(c: Context, forcedTarget?: ClientType) {
  const tokenParam = c.req.param('subToken');
  const sourceIdParam = c.req.param('sourceId');
  const appConfig = getAppConfig();

  if (typeof tokenParam !== 'string' || !tokenParam || typeof sourceIdParam !== 'string' || !sourceIdParam) {
    c.header('X-Powered-By', undefined);
    return c.text('404 Not Found', 404);
  }

  const profile = (appConfig.profiles || []).find(p => p.token === tokenParam && p.enabled !== false);
  if (!profile) {
    c.header('X-Powered-By', undefined);
    return c.text('404 Not Found', 404);
  }

  const cleanId = sourceIdParam.trim().toLowerCase();
  const matchedSource = (appConfig.sources || []).find(s =>
    s.enabled && (
      s.id.toLowerCase() === cleanId ||
      s.name.trim().toLowerCase() === cleanId ||
      (cleanId === 'custom' && (s.type === 'custom' || s.id === 'custom'))
    )
  );

  if (!matchedSource) {
    c.header('X-Powered-By', undefined);
    return c.text('404 Not Found', 404);
  }

  try {
    let sourceNodes: ProxyNode[] = matchedSource.nodes || [];
    const userinfo = Object.entries(parseSubscriptionUserinfo(matchedSource.subscriptionUserinfo))
      .map(([key, value]) => `${key}=${value}`).join('; ');
    if (userinfo) c.header('subscription-userinfo', userinfo);

    // 应用提取规则
    sourceNodes = applyExtractionRules(sourceNodes, appConfig.rules);

    const queryTarget = (c.req.query('target') as string) || (c.req.query('type') as string) || (c.req.param('target') as string);
    const userAgent = c.req.header('user-agent');
    const detectedType = forcedTarget || detectClientType(userAgent, queryTarget, 'loon');

    if (detectedType === 'loon') {
      const proxyLines = sourceNodes.map(nodeToLoonProxy);
      const output = ['[Proxy]', ...proxyLines].join('\n');
      c.header('Content-Type', 'text/plain; charset=utf-8');
      return c.body(output);
    }

    if (detectedType === 'mihomo') {
      const proxies = sourceNodes.map(nodeToMihomoProxy);
      const output = yaml.dump({ proxies }, { indent: 2, lineWidth: -1, noRefs: true });
      c.header('Content-Type', 'text/yaml; charset=utf-8');
      return c.body(output);
    }

    if (detectedType === 'quantumultx') {
      const proxyLines = sourceNodes.map(nodeToQuantumultXProxy);
      const output = proxyLines.join('\n');
      c.header('Content-Type', 'text/plain; charset=utf-8');
      return c.body(output);
    }

    if (detectedType === 'egern') {
      const proxies = sourceNodes.map(nodeToEgernProxy);
      const output = yaml.dump({ proxies }, { indent: 2, lineWidth: -1 });
      c.header('Content-Type', 'text/yaml; charset=utf-8');
      return c.body(output);
    }

    const output = generateShadowrocketBase64(sourceNodes);
    c.header('Content-Type', 'text/plain; charset=utf-8');
    return c.body(output);
  } catch (err: any) {
    console.error('Source subscription generation error:', err);
    return c.html(`Generation error: ${err.message || err}`, 500);
  }
}

// Secret Token Routes
subRouter.get('/s/:subToken/source/:sourceId/loon', (c) => handleSourceSubRequest(c, 'loon'));
subRouter.get('/s/:subToken/source/:sourceId/:target', (c) => {
  const target = c.req.param('target');
  const mapped = target === 'qx' ? 'quantumultx' : (target === 'rocket' ? 'shadowrocket' : target);
  return handleSourceSubRequest(c, mapped as ClientType);
});
subRouter.get('/s/:subToken/source/:sourceId', (c) => handleSourceSubRequest(c));

subRouter.get('/s/:subToken', (c) => handlePrivateSubRequest(c));
subRouter.get('/s/:subToken/mihomo', (c) => handlePrivateSubRequest(c, 'mihomo'));
subRouter.get('/s/:subToken/singbox', (c) => handlePrivateSubRequest(c, 'singbox'));
subRouter.get('/s/:subToken/loon', (c) => handlePrivateSubRequest(c, 'loon'));
subRouter.get('/s/:subToken/qx', (c) => handlePrivateSubRequest(c, 'quantumultx'));
subRouter.get('/s/:subToken/quantumultx', (c) => handlePrivateSubRequest(c, 'quantumultx'));
subRouter.get('/s/:subToken/egern', (c) => handlePrivateSubRequest(c, 'egern'));
subRouter.get('/s/:subToken/shadowrocket', (c) => handlePrivateSubRequest(c, 'shadowrocket'));
subRouter.get('/s/:subToken/rocket', (c) => handlePrivateSubRequest(c, 'shadowrocket'));
subRouter.get('/s/:subToken/:target', (c) => {
  const target = c.req.param('target');
  if (
    target === 'mihomo' ||
    target === 'singbox' ||
    target === 'loon' ||
    target === 'quantumultx' ||
    target === 'qx' ||
    target === 'egern' ||
    target === 'shadowrocket' ||
    target === 'rocket'
  ) {
    const mapped = target === 'qx' ? 'quantumultx' : (target === 'rocket' ? 'shadowrocket' : target);
    return handlePrivateSubRequest(c, mapped as ClientType);
  }
  return handlePrivateSubRequest(c);
});
