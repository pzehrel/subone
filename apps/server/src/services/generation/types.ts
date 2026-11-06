import type { RuntimeInventory, RuntimePathEntry } from './runtime-dependencies';
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
}
export interface GenerationPlan {
  target: { type: ClientType; version?: string; mode: 'complete' | 'nodes' };
  templateContent: string;
  inventory: RuntimeInventory;
  template?: ConfigTemplate;
  ordinaryNodes: ProxyNode[];
  dependencyNodes: ProxyNode[];
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
  bindings: (Omit<GenerationBinding, 'services'> & { services: { id: string; url: string }[] })[];
  diagnostics: GenerationDiagnostic[];
}
export function generationMetadata(plan: GenerationPlan): GenerationMetadata {
  return {
    target: plan.target, nodeCount: plan.ordinaryNodes.length, dependencyNodeCount: plan.dependencyNodes.length,
    bindings: plan.bindings.map(binding => ({ ...binding, services: binding.services.map(({ id, url }) => ({ id, url })) })),
    diagnostics: plan.bindings.flatMap(binding => binding.diagnostics),
  };
}
export class GenerationError extends Error {
  constructor(message: string, public generation: GenerationMetadata) { super(message); }
}
