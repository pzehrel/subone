import yaml from 'js-yaml';
import { nodeToEgernProxy, generateEgernConfig, EgernConfigError, egernEntry } from '../../../core/generators/egern-generator';
import { nodeReferenceId, groupReferenceId } from '../../node-references';
import { registerRuntimeDependencyCollector, type RuntimeDependencyCollection } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationPlan } from '../types';
import { renderEgernDomainDns } from '../native-domain-dns';

/** Domain forward rules select the source's native encrypted upstream group. */
export function renderEgern(plan: GenerationPlan): string {
  try {
    const output = generateEgernConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources, { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds), ordinaryGroupIds: new Set(plan.ordinaryGroupIds), inventorySources: plan.inventory.sources });
    return plan.target.mode === 'nodes' ? output : renderEgernDomainDns(output, plan);
  } catch (error) {
    throwEgernGenerationError(plan, error);
  }
}

function throwEgernGenerationError(plan: GenerationPlan, error: unknown): never {
  if (!(error instanceof EgernConfigError)) throw error;
  const metadata = generationMetadata(plan);
  metadata.diagnostics.push({ code: error.code, severity: 'error', message: error.message });
  throw new GenerationError(error.message, metadata);
}

export function renderEgernSource(plan: GenerationPlan, sourceId: string): string {
  const nodes = plan.ordinaryNodes.filter(node => node.sourceId === sourceId);
  const providerPlan = structuredClone(plan);
  providerPlan.target.mode = 'nodes';
  providerPlan.templateContent = 'proxies: []\npolicy_groups: []\nrules: []\n';
  providerPlan.rules = [];
  providerPlan.ordinaryNodes = nodes; providerPlan.dependencyNodes = []; providerPlan.ordinaryGroupIds = [];
  const required = collectEgernDependencies(providerPlan);
  const nodeIds = new Set(required.nodes.map(requirement => requirement.nodeId));
  providerPlan.dependencyNodes = [...plan.ordinaryNodes, ...plan.dependencyNodes].filter(node => nodeIds.has(node.id) && !nodes.some(ordinary => ordinary.id === node.id));
  const groupIds = new Set(required.groups.map(requirement => requirement.groupId));
  providerPlan.groups = plan.groups.filter(group => groupIds.has(group.id)); providerPlan.dependencyGroupIds = [...groupIds];
  providerPlan.sources = [];
  providerPlan.bindings = providerPlan.bindings.flatMap(binding => {
    const nodeIds = binding.nodeIds.filter(id => [...providerPlan.ordinaryNodes, ...providerPlan.dependencyNodes].some(node => node.id === id));
    return nodeIds.length ? [{ ...binding, nodeIds, services: [] }] : [];
  });
  renderEgern(providerPlan);
  try {
    return yaml.dump({ proxies: nodes.map(nodeToEgernProxy) }, { indent: 2, lineWidth: -1, noRefs: true });
  } catch (error) { return throwEgernGenerationError(plan, error); }
}

/** Native routing uses ordinary candidates; connection-only chains can complete inventory. */
export function collectEgernDependencies(plan: GenerationPlan): RuntimeDependencyCollection {
  const result: RuntimeDependencyCollection = { nodes: [], groups: [] };
  const included = new Set([...plan.ordinaryNodes, ...plan.dependencyNodes].map(node => node.id));
  const visited = new Set<string>();
  let document: any;
  try { document = yaml.load(plan.templateContent) || {}; } catch { return result; }
  const templateDefinitions = [...(Array.isArray(document.proxies) ? document.proxies : []), ...(Array.isArray(document.policy_groups) ? document.policy_groups : [])].filter(entry => entry && typeof entry === 'object' && Object.keys(entry).length === 1).map(egernEntry);
  const once = (key: string) => { if (visited.has(key)) return false; visited.add(key); return true; };
  const node = (id: string, owner: string, reason: string[]) => {
    if (!once(`${owner}:node:${id}`)) return;
    const entry = plan.inventory.nodes.find(entry => entry.node.id === id);
    result.nodes.push({ nodeId: id, sourceId: entry?.sourceId, state: !entry ? 'missing' : entry.state !== 'enabled' ? entry.state : included.has(id) ? 'included' : 'omitted', bindingSourceId: owner, reason });
    if (!entry || entry.state !== 'enabled') return;
    try { nodeToEgernProxy(entry.node); } catch { return; }
    if (entry.node.detourRef) reference(entry.node.detourRef, owner, [...reason, entry.node.name, 'prev_hop']);
  };
  const ordinaryGroups = new Set(plan.ordinaryGroupIds);
  const group = (id: string, owner: string, reason: string[], ordinary = false) => {
    if (ordinary) ordinaryGroups.add(id);
    if (!once(`${owner}:group:${id}:${ordinary}`)) return;
    result.groups.push({ groupId: id, bindingSourceId: owner, reason, ordinary });
    const value = plan.inventory.groups.find(group => group.id === id);
    if (!value || ['direct', 'reject', 'relay'].includes(value.type)) return;
    for (const member of value.proxies || []) reference(member, owner, [...reason, value.name], ordinary);
    const mounts = value.sources ?? value.use;
    const candidates = mounts?.length ? (ordinaryGroups.has(id) ? plan.ordinaryNodes.map(node => ({ node, sourceId: node.sourceId })) : plan.inventory.nodes).filter(entry => {
      const source = plan.inventory.sources.find(source => source.id === entry.sourceId);
      return !!entry.sourceId && mounts.includes(entry.sourceId) || !!source && mounts.includes(source.name);
    }).map(entry => entry.node) : plan.ordinaryNodes;
    let regex: RegExp | undefined;
    try { if (value.filter) regex = new RegExp(value.filter.replace(/\(\?i\)/g, ''), 'i'); } catch { return; }
    if (mounts?.length || value.filter || value.includeAll || !value.proxies?.length) for (const candidate of candidates) {
      if (!regex || regex.test(candidate.name)) node(candidate.id, owner, [...reason, value.name]);
    }
  };
  const reference = (name: string, owner: string, reason: string[], ordinary = false) => {
    const native = name.startsWith('template:');
    if (native) name = name.slice(9);
    const template = templateDefinitions.find(entry => entry?.name === name);
    if (template) {
      if (!once(`${owner}:template:${name}:${ordinary}`)) return;
      if (template.prev_hop) reference(template.prev_hop, owner, [...reason, name, 'prev_hop']);
      for (const policy of template.policies || []) reference(policy, owner, [...reason, name], ordinary);
      if (template.default_policy) reference(template.default_policy, owner, [...reason, name], ordinary);
      for (const rule of template.rules || []) { const value = egernEntry(rule); if (value?.policy && !value.disabled) reference(value.policy, owner, [...reason, name], ordinary); }
      return;
    }
    if (native) return;
    const nodeId = nodeReferenceId(name); const groupId = groupReferenceId(name);
    if (nodeId) return node(nodeId, owner, reason);
    if (groupId) return group(groupId, owner, reason, ordinary);
    const selectedNode = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.name === name);
    if (selectedNode) return node(selectedNode.id, owner, reason);
    const selectedGroup = plan.inventory.groups.find(group => group.name === name);
    if (selectedGroup) group(selectedGroup.id, owner, reason, ordinary);
  };
  const owner = plan.bindings[0]?.sourceId || '';
  for (const rule of Array.isArray(document.rules) ? document.rules : []) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    if ('default' in rule && plan.rules.some(rule => rule.enabled && rule.type === 'FINAL')) continue;
    const value = egernEntry(rule); if (value?.policy && !value.disabled) reference(value.policy, owner, ['Egern routing', value.policy], true);
  }
  for (const key of ['default_proxy_group', 'default_subscription_group']) if (document[key]) reference(document[key], owner, ['Egern routing', key], true);
  for (const current of [...plan.ordinaryNodes, ...plan.dependencyNodes]) node(current.id, current.sourceId || '', [current.sourceName || current.sourceId || current.name]);
  for (const entry of templateDefinitions) if (entry?.prev_hop) reference(entry.prev_hop, plan.bindings[0]?.sourceId || '', [entry.name, 'prev_hop']);
  return result;
}
registerRuntimeDependencyCollector('egern', collectEgernDependencies);
