import { createGenerationPlan, renderGeneration, renderSourceGeneration, GenerationError } from '../services/generation';
import { Hono, type Context } from 'hono';
import { getAppConfig, getBaseUrl } from '../context';
import { detectClientType, ClientType } from '../core/parser/ua-detector';
import { ConfigTemplate } from '../types/index';
import { UnsupportedProxyGroupError } from '../core/generators/errors';
import { formatSubscriptionUserinfo, parseSubscriptionUserinfo } from '../core/parser/subscription-info';
import { aggregateSubscriptionInfo } from '../../../../shared/subscription-info';
import {
  getEffectiveRulesForProfile,
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

    const expandQuery = c.req.query('expand');
    const plan = await createGenerationPlan({
      target: detectedType, profile, templateContent: tpl?.content || '', templateId: tpl?.id,
      expandNodes: expandQuery === 'false' || expandQuery === '0' ? false : expandQuery === 'true' || expandQuery === '1' || c.req.query('node_list') === 'true' ? true : undefined,
      format: c.req.query('format'), baseUrl: getBaseUrl(c.req), subToken: tokenParam,
    });
    const userinfo = formatSubscriptionUserinfo(aggregateSubscriptionInfo(plan.sources.map(source => source.subscriptionInfo)));
    if (userinfo) c.header('subscription-userinfo', userinfo);
    const result = renderGeneration(plan);
    c.header('Content-Type', result.contentType);
    c.header('X-SubOne-DoH', result.generation.bindings.map(binding => binding.status).join(','));
    return c.body(result.output);

  } catch (err: any) {
    if (err instanceof GenerationError) return c.json({ success: false, message: err.message, generation: err.generation }, 422);
    if (err instanceof UnsupportedProxyGroupError) return c.text(err.message, 422);
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
    const queryTarget = c.req.query('target') || c.req.query('type') || c.req.param('target');
    const detectedType = forcedTarget || detectClientType(c.req.header('user-agent'), queryTarget, 'loon');
    const plan = await createGenerationPlan({ target: detectedType, profile, templateContent: getEffectiveTemplateForProfile(profile, detectedType)?.content || '', baseUrl: getBaseUrl(c.req) });
    const userinfo = Object.entries(parseSubscriptionUserinfo(matchedSource.subscriptionUserinfo))
      .map(([key, value]) => `${key}=${value}`).join('; ');
    if (userinfo && plan.ordinaryNodes.some(node => node.sourceId === matchedSource.id)) c.header('subscription-userinfo', userinfo);
    const result = renderSourceGeneration(plan, matchedSource.id);
    c.header('Content-Type', result.contentType);
    return c.body(result.output);

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
