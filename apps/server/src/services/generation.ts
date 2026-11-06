import yaml from 'js-yaml';
import { getAppConfig } from '../context';
import { generateMihomoConfig } from '../core/generators/mihomo-generator';
import { generateSingboxDocument } from '../core/generators/singbox-generator';
import { generateLoonConfig, nodeToLoonProxy } from '../core/generators/loon-generator';
import { generateQuantumultXConfig, nodeToQuantumultXProxy } from '../core/generators/quantumultx-generator';
import { generateShadowrocketConfig, generateShadowrocketBase64 } from '../core/generators/shadowrocket-generator';
import { getEffectiveNodes, getEffectiveNodesForProfile, getEffectiveGroupsForProfile, getEffectiveRulesForProfile, getEffectiveSourcesForProfile } from './profile-service';
import { requiresExpandedNodes, resolveOutputReferences, prepareTemplateReferences, resolveTemplateReferences, templateOutboundNames, nodeReference, groupReference } from './node-references';
import { createRuntimeInventory, collectRuntimeDependencies, validateSingboxRuntime } from './generation/runtime-dependencies';
import { adaptSingboxDns } from './generation/adapters/singbox';
import { renderEgern, renderEgernSource } from './generation/adapters/egern';
import { adaptLoonDns, validateLoonRuntime } from './generation/adapters/loon';
import { adaptMihomoDns, renderMihomoSource, validateMihomoRuntime } from './generation/adapters/mihomo';
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
  const stableTemplate = (nodes: typeof ordinary, selectedGroups: typeof groups) => resolveTemplateReferences(template, nodes.map(node => ({ ...node, name: nodeReference(node.id) })), selectedGroups.map(group => ({ ...group, name: groupReference(group.id) })));
  const nodeOnly = options.target === 'shadowrocket' && ['base64', 'b64'].includes(options.format || '');
  const plan: GenerationPlan = {
    target: { type: options.target, ...(options.target === 'singbox' ? { version: '1.14.4' } : options.target === 'egern' ? { version: '2.21.0' } : options.target === 'mihomo' ? { version: '1.19.33' } : options.target === 'loon' ? { version: '3.5.3' } : {}), mode: nodeOnly ? 'nodes' : 'complete' },
    templateContent: stableTemplate(ordinary, groups), template, inventory: createRuntimeInventory(config),
    ordinaryNodes: structuredClone(ordinary), dependencyNodes: [], dependencyGroupIds: [], dependencyReasons: [], groups: structuredClone(groups),
    rules: structuredClone(options.profile ? getEffectiveRulesForProfile(options.profile) : config.rulesList),
    sources: structuredClone(sources.filter(source => source.enabled && (ordinary.some(node => node.sourceId === source.id) || options.profile?.nodeFilter?.sourceIds?.includes(source.id) || groups.some(group => (group.sources ?? group.use)?.some(mount => mount === source.id || mount === source.name))))),
    bindings: [],
    expandNodes: requiresExpandedNodes(groups) || (options.expandNodes ?? (options.target === 'shadowrocket')),
    baseUrl: options.baseUrl || '', subToken: options.subToken || options.profile?.token || 'preview-token',
  };
  const bindNodes = () => {
    const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes];
    plan.bindings = plan.inventory.sources.flatMap(source => {
      const nodeIds = nodes.filter(node => node.sourceId === source.id).map(node => node.id);
      if (!nodeIds.length) return [];
      return [{ sourceId: source.id, sourceName: source.name, batchId: source.doh?.batchId, updatedAt: source.doh?.updatedAt,
        nodeIds, services: structuredClone(source.doh?.services || []), status: nodeOnly ? 'ignored' as const : 'template' as const,
        method: nodeOnly ? 'nodes-only' : 'template-dns', appliedServiceIds: [], diagnostics: [] }];
    });
  };
  // Completion works on stable identities, before allocating any client-facing names.
  // Each newly required source can introduce its own DNS/bootstrap connections.
  let changed: boolean;
  do {
    bindNodes();
    changed = false;
    const required = collectRuntimeDependencies(plan);
    const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
    for (const requirement of required.nodes) {
      if (requirement.state !== 'omitted' || included.has(requirement.nodeId)) continue;
      const entry = plan.inventory.nodes.find(entry => entry.node.id === requirement.nodeId);
      if (!entry || entry.state !== 'enabled') continue;
      plan.dependencyNodes.push(structuredClone(entry.node));
      plan.dependencyReasons!.push(requirement);
      included.add(entry.node.id); changed = true;
    }
    for (const requirement of required.groups) {
      if (plan.groups.some(group => group.id === requirement.groupId)) continue;
      const group = plan.inventory.groups.find(group => group.id === requirement.groupId);
      if (!group) continue;
      plan.groups.push(structuredClone(group)); plan.dependencyGroupIds.push(group.id); changed = true;
    }
    plan.templateContent = stableTemplate([...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups);
  } while (changed);
  const resolved = resolveOutputReferences([...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.inventory.sources, options.target, templateOutboundNames(template));
  const ordinaryIds = new Set(plan.ordinaryNodes.map(node => node.id));
  plan.ordinaryNodes = resolved.nodes.filter(node => ordinaryIds.has(node.id));
  plan.dependencyNodes = resolved.nodes.filter(node => !ordinaryIds.has(node.id));
  plan.groups = resolved.groups;
  plan.sources = plan.sources.map(source => ({ ...source, nodes: plan.ordinaryNodes.filter(node => node.sourceId === source.id) }));
  plan.templateContent = resolveTemplateReferences(template, resolved.nodes, resolved.groups);
  plan.rules = plan.rules.map(rule => {
    const matches = groups.filter(group => group.name === rule.outbound);
    return { ...rule, outbound: matches.length === 1 ? resolved.groups.find(group => group.id === matches[0].id)?.name || rule.outbound : rule.outbound };
  });
  return plan;
}

export function renderGeneration(input: GenerationPlan) {
  // Rendering can be repeated without accumulating diagnostics or changing a saved/source plan.
  const plan = structuredClone(input);
  const nodes = [...plan.ordinaryNodes, ...plan.dependencyNodes];
  const { groups, rules, sources, templateContent } = plan;
  const options = { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds) };
  let output: string;
  let contentType = 'text/plain; charset=utf-8';
  if (plan.target.mode === 'nodes') {
    output = generateShadowrocketBase64(plan.ordinaryNodes);
  } else if (plan.target.type === 'singbox') {
    const { document, nodeTags } = generateSingboxDocument(templateContent, nodes, groups, rules, sources, new Set(plan.ordinaryNodes.map(node => node.id)), new Set(plan.groups.filter(group => !plan.dependencyGroupIds.includes(group.id)).map(group => group.id)));
    adaptSingboxDns(document, plan, nodeTags);
    validateSingboxRuntime(document, plan, nodeTags);
    output = JSON.stringify(document, null, 2);
    contentType = 'application/json; charset=utf-8';
  } else if (plan.target.type === 'egern') {
    output = renderEgern(plan);
    contentType = 'text/yaml; charset=utf-8';
  } else if (plan.target.type === 'mihomo') {
    const document = yaml.load(generateMihomoConfig(templateContent, nodes, groups, rules, sources, options)) as Record<string, any>;
    adaptMihomoDns(document, plan);
    validateMihomoRuntime(document, plan);
    output = yaml.dump(document, { indent: 2, lineWidth: -1, noRefs: true });
    contentType = 'text/yaml; charset=utf-8';
  } else if (plan.target.type === 'loon') {
    output = generateLoonConfig(templateContent, nodes, groups, rules, sources, { ...options, nodeServerDns: adaptLoonDns(plan), runtimeSources: plan.inventory.sources });
    validateLoonRuntime(output, plan);
  } else {
    retainTemplateDns(plan);
    switch (plan.target.type) {
      case 'quantumultx': output = generateQuantumultXConfig(templateContent, nodes, groups, rules, sources, options); break;
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
    case 'mihomo': return renderMihomoSource(plan, sourceId);
    case 'loon': {
      renderGeneration(plan);
      const serverDns = adaptLoonDns(structuredClone(plan));
      return { output: ['[Proxy]', ...nodes.map(node => nodeToLoonProxy(node, serverDns.get(node.id)))].join('\n'), contentType: 'text/plain; charset=utf-8' };
    }
    case 'quantumultx': return { output: nodes.map(nodeToQuantumultXProxy).join('\n'), contentType: 'text/plain; charset=utf-8' };
    case 'egern': return { output: renderEgernSource(plan, sourceId), contentType: 'text/yaml; charset=utf-8' };
    default: return { output: generateShadowrocketBase64(nodes), contentType: 'text/plain; charset=utf-8' };
  }
}
