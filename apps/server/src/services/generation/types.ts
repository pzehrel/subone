import type { RuntimeInventory, RuntimePathEntry, RuntimeNodeRequirement } from './runtime-dependencies';
import type { ClientType, ConfigTemplate, ProxyGroupItem, ProxyNode, SourceDohService, SubscriptionProfile, SubscriptionSource, UnifiedRuleItem } from '../../types';

export interface GenerationDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sourceId?: string;
  serviceId?: string;
  path?: RuntimePathEntry[];
  dependencyState?: string;
}
export interface GenerationBinding {
  sourceId: string;
  sourceName: string;
  batchId?: string;
  updatedAt?: string;
  nodeIds: string[];
  services: SourceDohService[];
  status: 'applied' | 'degraded' | 'unapplied' | 'template' | 'ignored';
  method: string;
  appliedServiceIds: string[];
  diagnostics: GenerationDiagnostic[];
}
export interface GenerationOptions {
  target: ClientType;
  profile?: SubscriptionProfile;
  templateContent: string;
  templateId?: string;
  expandNodes?: boolean;
  baseUrl?: string;
  subToken?: string;
  format?: string;
  outputRole?: 'source';
}
export interface GenerationPlan {
  target: { type: ClientType; version?: string; mode: 'complete' | 'nodes' };
  templateContent: string;
  inventory: RuntimeInventory;
  template?: ConfigTemplate;
  ordinaryNodes: ProxyNode[];
  dependencyNodes: ProxyNode[];
  dependencyGroupIds: string[];
  dependencyReasons?: RuntimeNodeRequirement[];
  groups: ProxyGroupItem[];
  rules: UnifiedRuleItem[];
  sources: SubscriptionSource[];
  bindings: GenerationBinding[];
  expandNodes: boolean;
  baseUrl: string;
  subToken: string;
}
export interface GenerationMetadata {
  target: GenerationPlan['target'];
  nodeCount: number;
  dependencyNodeCount: number;
  dependencyNodes: { id: string; name: string; sourceId?: string; sourceName?: string; bindingSourceId?: string; reason: string[] }[];
  bindings: (Omit<GenerationBinding, 'services'> & { services: { id: string; url: string }[] })[];
  diagnostics: GenerationDiagnostic[];
}
export function generationMetadata(plan: GenerationPlan): GenerationMetadata {
  return {
    target: plan.target, nodeCount: plan.ordinaryNodes.length, dependencyNodeCount: plan.dependencyNodes.length,
    dependencyNodes: plan.dependencyNodes.map(node => {
      const requirement = plan.dependencyReasons?.find(value => value.nodeId === node.id);
      return { id: node.id, name: node.name, sourceId: node.sourceId, sourceName: plan.inventory.sources.find(source => source.id === node.sourceId)?.name, bindingSourceId: requirement?.bindingSourceId, reason: (requirement?.reason || []).map(label => {
        try { const url = new URL(label); return `${url.protocol}//${url.hostname}${url.pathname}`; } catch { return label; }
      }) };
    }),
    bindings: plan.bindings.map(binding => ({ ...binding, services: binding.services.map(({ id, url }) => ({ id, url })) })),
    diagnostics: plan.bindings.flatMap(binding => binding.diagnostics),
  };
}
export class GenerationError extends Error {
  constructor(message: string, public generation: GenerationMetadata) { super(message); }
}
