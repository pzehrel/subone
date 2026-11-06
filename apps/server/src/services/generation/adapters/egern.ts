import yaml from 'js-yaml';
import { nodeToEgernProxy, generateEgernConfig, EgernConfigError } from '../../../core/generators/egern-generator';
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
    return generateEgernConfig(plan.templateContent, [...plan.ordinaryNodes, ...plan.dependencyNodes], plan.groups, plan.rules, plan.sources, { expandNodes: plan.expandNodes, baseUrl: plan.baseUrl, subToken: plan.subToken, ordinaryNodeIds: new Set(plan.ordinaryNodes.map(node => node.id)) });
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
  try {
    return yaml.dump({ proxies: plan.ordinaryNodes.filter(node => node.sourceId === sourceId).map(nodeToEgernProxy) }, { indent: 2, lineWidth: -1, noRefs: true });
  } catch (error) { return throwEgernGenerationError(plan, error); }
}
