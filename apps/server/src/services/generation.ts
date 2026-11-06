import yaml from 'js-yaml';
import { getAppConfig } from '../context';
import { generateMihomoConfig, nodeToMihomoProxy } from '../core/generators/mihomo-generator';
import { generateSingboxDocument } from '../core/generators/singbox-generator';
import { generateLoonConfig, nodeToLoonProxy } from '../core/generators/loon-generator';
import { generateQuantumultXConfig, nodeToQuantumultXProxy } from '../core/generators/quantumultx-generator';
import { generateEgernConfig, nodeToEgernProxy } from '../core/generators/egern-generator';
import { generateShadowrocketConfig, generateShadowrocketBase64 } from '../core/generators/shadowrocket-generator';
import { getEffectiveNodes, getEffectiveNodesForProfile, getEffectiveGroupsForProfile, getEffectiveRulesForProfile, getEffectiveSourcesForProfile } from './profile-service';
import { requiresExpandedNodes, resolveOutputReferences, prepareTemplateReferences, resolveTemplateReferences, templateOutboundNames } from './node-references';
import { createRuntimeInventory, validateSingboxRuntime } from './generation/runtime-dependencies';
import { adaptSingboxDns } from './generation/adapters/singbox';
import { adaptMihomoDns, validateMihomoRuntime } from './generation/adapters/mihomo';
import { retainTemplateDns } from './generation/adapters/unsupported';
import { GenerationError, generationMetadata, type GenerationOptions, type GenerationPlan } from './generation/types';
export { GenerationError } from './generation/types';
export type { GenerationPlan, GenerationMetadata, GenerationBinding, GenerationDiagnostic } from './generation/types';

/** All dispatch paths select and name the same enabled profile nodes before provider slicing. */
export async function createGenerationPlan(options: GenerationOptions): Promise<GenerationPlan> {
  const config = getAppConfig();
  const ordinary = options.profile ? await getEffectiveNodesForProfile(options.profile) : await getEffectiveNodes();
  const groups = options.profile ? getEffectiveGroupsForProfile(options.profile, ordinary) : config.proxyGroups;
  const sources = options.profile ? getEffectiveSourcesForProfile(options.profile, ordinary) : config.sources;
  const savedTemplate = config.templates.find(template => template.id === (options.templateId || options.profile?.templates?.[options.target])) || config.templates.find(template => template.type === options.target && template.content === options.templateContent);
  const template = prepareTemplateReferences({ ...(savedTemplate || { id: 'unsaved', name: '', type: options.target }), content: options.templateContent }, config, savedTemplate);
  const resolved = resolveOutputReferences(ordinary, groups, sources, options.target, templateOutboundNames(template));
  const nodeOnly = options.target === 'shadowrocket' && ['base64', 'b64'].includes(options.format || '');
  return {
    target: { type: options.target, ...(options.target === 'singbox' ? { version: '1.14.4' } : options.target === 'mihomo' ? { version: '1.19.33' } : {}), mode: nodeOnly ? 'nodes' : 'complete' },
    templateContent: resolveTemplateReferences(template, resolved.nodes, resolved.groups), template, inventory: createRuntimeInventory(config),
    ordinaryNodes: resolved.nodes, dependencyNodes: [], groups: resolved.groups,
    rules: (options.profile ? getEffectiveRulesForProfile(options.profile) : config.rulesList).map(rule => {
      const matches = groups.filter(group => group.name === rule.outbound);
      return { ...rule, outbound: matches.length === 1 ? resolved.groups.find(group => group.id === matches[0].id)?.name || rule.outbound : rule.outbound };
    }),
    sources: resolved.sources,
    bindings: resolved.sources.flatMap(source => {
      const nodeIds = resolved.nodes.filter(node => node.sourceId === source.id).map(node => node.id);
      if (!nodeIds.length) return [];
      return [{ sourceId: source.id, sourceName: source.name, batchId: source.doh?.batchId, updatedAt: source.doh?.updatedAt,
        nodeIds, services: structuredClone(source.doh?.services || []), status: nodeOnly ? 'ignored' as const : 'template' as const,
        method: nodeOnly ? 'nodes-only' : 'template-dns', appliedServiceIds: [], diagnostics: [] }];
    }),
    expandNodes: requiresExpandedNodes(groups) || (options.expandNodes ?? (options.target === 'shadowrocket')),
    baseUrl: options.baseUrl || '', subToken: options.subToken || options.profile?.token || 'preview-token',
  };
}

export function renderGeneration(input: GenerationPlan) {
  // Rendering can be repeated without accumulating diagnostics or changing a saved/source plan.
  const plan = structuredClone(input);
  const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes];
  const { groups, rules, sources, templateContent } = plan;
  const options = { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set((plan as GenerationPlan & { dependencyGroupIds?: string[] }).dependencyGroupIds || []) };
  let output: string;
  let contentType = 'text/plain; charset=utf-8';
  if (plan.target.mode === 'nodes') {
    output = generateShadowrocketBase64(plan.ordinaryNodes);
  } else if (plan.target.type === 'singbox') {
    const { document, nodeTags } = generateSingboxDocument(templateContent, nodes, groups, rules, sources, new Set(plan.ordinaryNodes.map(node => node.id)));
    adaptSingboxDns(document, plan, nodeTags);
    validateSingboxRuntime(document, plan, nodeTags);
    output = JSON.stringify(document, null, 2);
    contentType = 'application/json; charset=utf-8';
  } else if (plan.target.type === 'mihomo') {
    const document = yaml.load(generateMihomoConfig(templateContent, nodes, groups, rules, sources, options)) as Record<string, any>;
    adaptMihomoDns(document, plan);
    validateMihomoRuntime(document, plan);
    output = yaml.dump(document, { indent: 2, lineWidth: -1, noRefs: true });
    contentType = 'text/yaml; charset=utf-8';
  } else {
    retainTemplateDns(plan);
    switch (plan.target.type) {
      case 'loon': output = generateLoonConfig(templateContent, nodes, groups, rules, sources, options); break;
      case 'quantumultx': output = generateQuantumultXConfig(templateContent, nodes, groups, rules, sources, options); break;
      case 'egern': output = generateEgernConfig(templateContent, nodes, groups, rules, sources, options); contentType = 'text/yaml; charset=utf-8'; break;
      case 'shadowrocket': output = generateShadowrocketConfig(templateContent, nodes, groups, rules, sources, options); break;
    }
  }
  const generation = generationMetadata(plan);
  if (generation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new GenerationError('来源 DoH 绑定需修复', generation);
  return { output, contentType, generation };
}

/** Allocate against the full profile, then slice. Client adapters can share this provider interface. */
export function renderSourceGeneration(plan: GenerationPlan, sourceId: string) {
  const nodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  switch (plan.target.type) {
    case 'mihomo': {
      const final = yaml.load(renderGeneration({ ...plan, expandNodes: true }).output) as Record<string, any>;
      return { output: yaml.dump({ proxies: nodes.map(node => final.proxies.find((proxy: any) => proxy.name === node.name) || nodeToMihomoProxy(node)) }, { indent: 2, lineWidth: -1, noRefs: true }), contentType: 'text/yaml; charset=utf-8' };
    }
    case 'loon': return { output: ['[Proxy]', ...nodes.map(nodeToLoonProxy)].join('\n'), contentType: 'text/plain; charset=utf-8' };
    case 'quantumultx': return { output: nodes.map(nodeToQuantumultXProxy).join('\n'), contentType: 'text/plain; charset=utf-8' };
    case 'egern': return { output: yaml.dump({ proxies: nodes.map(nodeToEgernProxy) }, { indent: 2, lineWidth: -1 }), contentType: 'text/yaml; charset=utf-8' };
    default: return { output: generateShadowrocketBase64(nodes), contentType: 'text/plain; charset=utf-8' };
  }
}
