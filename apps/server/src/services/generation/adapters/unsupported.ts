import type { GenerationPlan } from '../types';

/** Retain source intent and template DNS until a target has a verified adapter. */
export function retainTemplateDns(plan: GenerationPlan): void {
  for (const binding of plan.bindings) {
    if (!binding.services.length) continue;
    binding.status = 'unapplied';
    binding.method = 'template-dns';
    binding.diagnostics.push({ code: 'source-doh-unsupported', severity: 'warning', sourceId: binding.sourceId, message: `${plan.target.type} 尚未采用此来源的节点解析 DoH；保留模板 DNS` });
  }
}
