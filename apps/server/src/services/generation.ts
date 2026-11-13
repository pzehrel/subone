import { outputAllocator } from './generation/group-members';
import { bindNodes, completeOutputDependencies } from './generation/dependency-completion';
import yaml from 'js-yaml';
import { dynamicGroupNodes } from '../core/generators/group-nodes';
import { getAppConfig } from '../context';
import { generateMihomoConfig } from '../core/generators/mihomo-generator';
import { generateSingboxDocument } from '../core/generators/singbox-generator';
import { generateLoonConfig, nodeToLoonProxy } from '../core/generators/loon-generator';
import { generateShadowrocketConfig, generateShadowrocketBase64, nodeToUri, nodeToShadowrocketProxy } from '../core/generators/shadowrocket-generator';
import { getEffectiveNodes, getEffectiveNodesForProfile, getEffectiveGroupsForProfile, getEffectiveRulesForProfile, getEffectiveSourcesForProfile } from './profile-service';
import { prepareTemplateReferences, resolveTemplateReferences, nodeReference, groupReference } from './node-references';
import { createRuntimeInventory, validateSingboxRuntime } from './generation/runtime-dependencies';
import { adaptSingboxDns } from './generation/adapters/singbox';
import { renderEgern, renderEgernSource } from './generation/adapters/egern';
import { adaptLoonDns, validateLoonRuntime } from './generation/adapters/loon';
import { adaptMihomoDns, renderMihomoSource, validateMihomoRuntime } from './generation/adapters/mihomo';
import { adaptShadowrocketDns, diagnosePureNodes, validateShadowrocketRuntime } from './generation/adapters/shadowrocket';
import { renderQuantumultX, renderQuantumultXSource, validateQuantumultXNodeChains } from './generation/adapters/quantumultx';
import type { ProxyNode } from '../types';
import { isSupportedByQuantumultX } from '../core/generators/quantumultx-generator';
import { renderIniDomainDns } from './generation/native-domain-dns';
import { GenerationError, generationMetadata, type GenerationMetadata, type GenerationOptions, type GenerationPlan } from './generation/types';
export { GenerationError } from './generation/types';
export { renderQuantumultXNodes } from './generation/adapters/quantumultx';
export type { GenerationPlan, GenerationMetadata, GenerationBinding, GenerationDiagnostic } from './generation/types';

/** All dispatch paths select and name the same enabled profile nodes before provider slicing. */
export async function createGenerationPlan(options: GenerationOptions): Promise<GenerationPlan> {
  const config = structuredClone(getAppConfig());
  options = structuredClone(options);
  const uriNodes = options.target === 'shadowrocket' && ['base64', 'b64'].includes(options.format || '');
  const nodeOnly = uriNodes || options.outputRole === 'nodes';
  const supportsNode = (node: ProxyNode): boolean => {
    if (uriNodes) return !!nodeToUri(node);
    if (options.target === 'quantumultx') return isSupportedByQuantumultX(node);
    if (options.target === 'loon') return !nodeToLoonProxy(node).startsWith('#');
    if (options.target === 'shadowrocket') return !nodeToShadowrocketProxy(node).startsWith('#');
    // Targets with authoritative conversion errors keep reporting them during rendering.
    return true;
  };
  const selected = options.profile ? await getEffectiveNodesForProfile(options.profile, config) : await getEffectiveNodes(config);
  const ordinary = uriNodes ? selected : selected.filter(supportsNode);
  const groups = options.profile ? getEffectiveGroupsForProfile(options.profile, ordinary, config) : config.proxyGroups;
  const sources = options.profile ? getEffectiveSourcesForProfile(options.profile, ordinary, config) : config.sources;
  const savedTemplate = config.templates.find(template => template.id === (options.templateId || options.profile?.templates?.[options.target])) || config.templates.find(template => template.type === options.target && template.content === options.templateContent);
  const template = nodeOnly ? { id: 'nodes-only', name: '', type: options.target, content: options.templateContent } : prepareTemplateReferences({ ...(savedTemplate || { id: 'unsaved', name: '', type: options.target }), content: options.templateContent }, config, savedTemplate);
  const stableTemplate = (nodes: typeof ordinary, selectedGroups: typeof groups) => resolveTemplateReferences(template, nodes.map(node => ({ ...node, name: nodeReference(node.id) })), selectedGroups.map(group => ({ ...group, name: groupReference(group.id) })));
  const plan: GenerationPlan = {
    target: { type: options.target, ...(options.target === 'singbox' ? { version: '1.14.4' } : options.target === 'egern' ? { version: '2.21.0' } : options.target === 'mihomo' ? { version: '1.19.33' } : options.target === 'loon' ? { version: '3.5.3' } : options.target === 'shadowrocket' ? { version: '2.2.93' } : options.target === 'quantumultx' ? { version: '1.8.0' } : {}), mode: nodeOnly ? 'nodes' : 'complete' },
    templateContent: stableTemplate(ordinary, groups), template, inventory: createRuntimeInventory(config),
    ordinaryNodes: structuredClone(ordinary), dependencyNodes: [], dependencyGroupIds: [], ordinaryGroupIds: groups.map(group => group.id), dependencyReasons: [], groups: structuredClone(groups),
    rules: structuredClone(options.profile ? getEffectiveRulesForProfile(options.profile, config) : config.rulesList),
    sources: structuredClone(sources.filter(source => source.enabled && (ordinary.some(node => node.sourceId === source.id) || options.profile?.nodeFilter?.sourceIds?.includes(source.id) || groups.some(group => (group.sources ?? group.use)?.some(mount => mount === source.id || mount === source.name))))),
    bindings: [],
    // Complete configurations update managed definitions and references together.
    expandNodes: true,
    baseUrl: options.baseUrl || '', subToken: options.subToken || options.profile?.token || 'preview-token',
    subscriptionName: options.profile?.name,
  };
  // Capability errors apply even when a target would otherwise omit that protocol.
  if (options.target === 'quantumultx') validateQuantumultXNodeChains({ ...plan, ordinaryNodes: selected });
  if (!nodeOnly && options.target === 'shadowrocket' && selected.some(node => !supportsNode(node))) {
    bindNodes(plan);
    adaptShadowrocketDns({ ...plan, ordinaryNodes: selected.filter(node => !supportsNode(node)), groups: [] });
    const generation = generationMetadata(plan);
    if (generation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new GenerationError('连接依赖需修复', generation);
  }
  const allocate = outputAllocator(plan, uriNodes);
  const necessaryGroups = completeOutputDependencies(plan, supportsNode, allocate);
  if (uriNodes) {
    // Preserve existing omission diagnostics, but omitted URI protocols never consume a number.
    diagnosePureNodes({ ...plan, ordinaryNodes: plan.ordinaryNodes.filter(node => !supportsNode(node)) });
    plan.ordinaryNodes = plan.ordinaryNodes.filter(supportsNode);
    const written = new Set(plan.ordinaryNodes.map(node => node.id));
    plan.bindings = plan.bindings.map(binding => ({ ...binding, nodeIds: binding.nodeIds.filter(id => written.has(id)) }));
  }
  const resolved = allocate([...plan.ordinaryNodes, ...plan.dependencyNodes]);
  const ordinaryIds = new Set(plan.ordinaryNodes.map(node => node.id));
  plan.ordinaryNodes = resolved.nodes.filter(node => ordinaryIds.has(node.id));
  plan.dependencyNodes = resolved.nodes.filter(node => !ordinaryIds.has(node.id));
  plan.groups = resolved.groups.map((group, index) => {
    const connectionMembers = plan.dynamicNodeIds?.get(group.id);
    const dynamic = plan.ordinaryGroupIds.includes(group.id)
      ? dynamicGroupNodes(plan.groups[index], plan.ordinaryNodes, plan.inventory.sources)
      : resolved.nodes.filter(node => connectionMembers?.includes(node.id));
    const members = [...new Set([...(group.proxies || []), ...dynamic.map(node => node.name)])];
    if (!members.length && !['direct', 'reject'].includes(group.type)) {
      if (necessaryGroups.has(group.id)) {
        const generation = generationMetadata(plan);
        generation.diagnostics.push({ code: 'source-doh-dependency-missing', severity: 'error', message: `必要策略组「${group.name}」没有可用成员，请调整成员或筛选条件` });
        throw new GenerationError('必要连接需修复', generation);
      }
      members.push('REJECT');
      // A relay requires hops and a QX destination hash requires servers. Render their empty fallback as a selector.
      const needsSelector = group.type === 'relay' || options.target === 'quantumultx' && group.type === 'load-balance' && group.strategy === 'consistent-hashing';
      return { ...group, type: needsSelector ? 'select' : group.type, proxies: members, membersResolved: true };
    }
    return { ...group, proxies: members, membersResolved: true };
  });
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
  const options = { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds), ordinaryGroupIds: new Set(plan.ordinaryGroupIds) };
  let output: string;
  let contentType = 'text/plain; charset=utf-8';
  if (plan.target.mode === 'nodes') {
    diagnosePureNodes(plan);
    output = generateShadowrocketBase64(plan.ordinaryNodes);
  } else if (plan.target.type === 'singbox') {
    const { document, nodeTags } = generateSingboxDocument(templateContent, nodes, groups, rules, sources, new Set(plan.ordinaryNodes.map(node => node.id)), new Set(plan.ordinaryGroupIds));
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
    const nodeServerDns = adaptLoonDns(plan);
    output = generateLoonConfig(plan.templateContent, nodes, groups, rules, sources, { ...options, nodeServerDns, runtimeSources: plan.inventory.sources });
    validateLoonRuntime(output, plan);
  } else if (plan.target.type === 'quantumultx') {
    output = renderQuantumultX(plan);
  } else {
    adaptShadowrocketDns(plan);
    output = generateShadowrocketConfig(templateContent, nodes, groups, rules, sources, { ...options, runtimeSources: plan.inventory.sources });
    output = renderIniDomainDns(output, plan, 'shadowrocket');
    validateShadowrocketRuntime(output, plan);
  }
  const generation = generationMetadata(plan);
  if (generation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new GenerationError('连接依赖需修复', generation);
  return { output, contentType, generation };
}

/** Allocate against the full profile, then slice. Client adapters can share this provider interface. */
export function renderSourceGeneration(plan: GenerationPlan, sourceId: string): { output: string; contentType: string; generation?: GenerationMetadata } {
  const nodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  if (plan.target.mode === 'nodes') return renderGeneration({ ...plan, ordinaryNodes: nodes, bindings: plan.bindings.filter(binding => binding.sourceId === sourceId) });
  switch (plan.target.type) {
    case 'mihomo': return renderMihomoSource(plan, sourceId);
    case 'loon': {
      const providerPlan = structuredClone(plan);
      providerPlan.ordinaryNodes = nodes; providerPlan.dependencyNodes = [];
      providerPlan.bindings = providerPlan.bindings.flatMap(binding => {
        const nodeIds = binding.nodeIds.filter(id => nodes.some(node => node.id === id));
        return nodeIds.length ? [{ ...binding, nodeIds }] : [];
      });
      const serverDns = adaptLoonDns(providerPlan);
      const generation = generationMetadata(providerPlan);
      if (generation.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new GenerationError('节点连接依赖需修复', generation);
      return { output: ['[Proxy]', ...nodes.map(node => nodeToLoonProxy(node, serverDns.get(node.id)))].join('\n'), contentType: 'text/plain; charset=utf-8', generation };
    }
    case 'quantumultx': return renderQuantumultXSource(plan, sourceId);
    case 'egern': return { output: renderEgernSource(plan, sourceId), contentType: 'text/yaml; charset=utf-8' };
    default: {
      const slice = structuredClone(plan);
      slice.target.mode = 'nodes'; slice.ordinaryNodes = nodes; slice.dependencyNodes = [];
      slice.bindings = slice.bindings.filter(binding => binding.sourceId === sourceId).map(binding => ({ ...binding, status: 'ignored' as const, method: 'nodes-only', appliedServiceIds: [], diagnostics: [] }));
      diagnosePureNodes(slice);
      return { output: generateShadowrocketBase64(nodes), contentType: 'text/plain; charset=utf-8', generation: generationMetadata(slice) };
    }
  }
}
