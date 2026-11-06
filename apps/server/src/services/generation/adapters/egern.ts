import yaml from 'js-yaml';
import { nodeToEgernProxy, generateEgernConfig, EgernConfigError, egernEntry } from '../../../core/generators/egern-generator';
import { nodeReferenceId, groupReferenceId } from '../../node-references';
import { registerRuntimeDependencyCollector, type RuntimeDependencyCollection } from '../runtime-dependencies';
import { GenerationError, generationMetadata, type GenerationPlan } from '../types';

/** Proxy DNS is shared/direct; node-server lookup semantics remain unproven. */
export function renderEgern(plan: GenerationPlan): string {
  for (const binding of plan.bindings) {
    if (!binding.services.length) continue;
    binding.status = 'unapplied';
    binding.method = 'template-dns';
    binding.diagnostics.push({ code: 'source-doh-unsupported', severity: 'warning', sourceId: binding.sourceId, message: 'Egern 保留模板 DNS；proxy_nameservers 是共享且强制直连的 Proxy DNS，尚未证实可分别解析各来源节点服务器域名；来源 DoH 及其出站均未采用' });
  }
  try {
    return generateEgernConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources, { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)), dependencyGroupIds: new Set(plan.dependencyGroupIds), inventorySources: plan.inventory.sources });
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
  // Providers participate in this same complete plan; dependency definitions stay static.
  renderEgern(structuredClone(plan));
  try {
    return yaml.dump({ proxies: plan.ordinaryNodes.filter(node => node.sourceId === sourceId).map(nodeToEgernProxy) }, { indent: 2, lineWidth: -1, noRefs: true });
  } catch (error) { return throwEgernGenerationError(plan, error); }
}

/** Only native connection chains are adopted; source DNS contributes no runtime edges. */
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
  const group = (id: string, owner: string, reason: string[]) => {
    if (!once(`${owner}:group:${id}`)) return;
    result.groups.push({ groupId: id, bindingSourceId: owner, reason });
    const value = plan.inventory.groups.find(group => group.id === id);
    if (!value || ['direct', 'reject', 'relay'].includes(value.type)) return;
    for (const member of value.proxies || []) reference(member, owner, [...reason, value.name]);
    const mounts = value.sources ?? value.use;
    const candidates = mounts?.length ? plan.inventory.nodes.filter(entry => {
      const source = plan.inventory.sources.find(source => source.id === entry.sourceId);
      return mounts.includes(entry.sourceId) || !!source && mounts.includes(source.name);
    }).map(entry => entry.node) : plan.ordinaryNodes;
    let regex: RegExp | undefined;
    try { if (value.filter) regex = new RegExp(value.filter.replace(/\(\?i\)/g, ''), 'i'); } catch { return; }
    if (mounts?.length || value.filter || value.includeAll || !value.proxies?.length) for (const candidate of candidates) {
      if (!regex || regex.test(candidate.name)) node(candidate.id, owner, [...reason, value.name]);
    }
  };
  const reference = (name: string, owner: string, reason: string[]) => {
    const template = templateDefinitions.find(entry => entry?.name === name);
    if (template) {
      if (!once(`${owner}:template:${name}`)) return;
      if (template.prev_hop) reference(template.prev_hop, owner, [...reason, name, 'prev_hop']);
      for (const policy of template.policies || []) reference(policy, owner, [...reason, name]);
      if (template.default_policy) reference(template.default_policy, owner, [...reason, name]);
      for (const rule of template.rules || []) { const value = egernEntry(rule); if (value?.policy && !value.disabled) reference(value.policy, owner, [...reason, name]); }
      return;
    }
    const nodeId = nodeReferenceId(name); const groupId = groupReferenceId(name);
    if (nodeId) return node(nodeId, owner, reason);
    if (groupId) return group(groupId, owner, reason);
    const selectedNode = [...plan.ordinaryNodes, ...plan.dependencyNodes].find(node => node.name === name);
    if (selectedNode) return node(selectedNode.id, owner, reason);
    const selectedGroup = plan.groups.find(group => group.name === name);
    if (selectedGroup) group(selectedGroup.id, owner, reason);
  };
  for (const current of [...plan.ordinaryNodes, ...plan.dependencyNodes]) node(current.id, current.sourceId || '', [current.sourceName || current.sourceId || current.name]);
  for (const entry of templateDefinitions) if (entry?.prev_hop) reference(entry.prev_hop, plan.bindings[0]?.sourceId || '', [entry.name, 'prev_hop']);
  return result;
}
registerRuntimeDependencyCollector('egern', collectEgernDependencies);
