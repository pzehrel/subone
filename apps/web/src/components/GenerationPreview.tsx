import type { ClientType, GenerationBinding, GenerationPreviewResult } from '../types';
import { Badge } from './ui/Badge';

const clientNames: Record<ClientType, string> = {
  singbox: 'sing-box',
  mihomo: 'Mihomo',
  loon: 'Loon',
  quantumultx: 'Quantumult X',
  egern: 'Egern',
  shadowrocket: 'Shadowrocket',
};

const bindingStatus: Record<GenerationBinding['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  applied: { label: '已生效', tone: 'success' },
  degraded: { label: '已降级', tone: 'warning' },
  unapplied: { label: '未生效', tone: 'warning' },
  template: { label: '沿用模板 DNS', tone: 'neutral' },
  ignored: { label: '未承载', tone: 'neutral' },
};

const methodNames: Record<string, string> = {
  'singbox-native-domain-resolver': '节点 domain_resolver',
  'mihomo-server-domain-policy': '节点域名 DNS 策略',
  'loon-server-dns': '节点 server-dns',
  'template-host-map': '模板 Host 映射',
  'template-dns': '模板 DNS',
  'nodes-only': '纯节点',
  'ip-node-no-dns': 'IP 地址，无需节点解析',
};

function batchTime(value?: string): string {
  if (!value) return '更新时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function GenerationPreview({ result, clientType }: { result: GenerationPreviewResult; clientType: ClientType }) {
  const generation = result.generation;
  const diagnostics = [...(generation?.diagnostics || []), ...(generation?.bindings.flatMap(binding => binding.diagnostics) || [])]
    .filter((diagnostic, index, all) => all.findIndex(other => other.code === diagnostic.code && other.message === diagnostic.message && other.sourceId === diagnostic.sourceId && other.serviceId === diagnostic.serviceId) === index);

  return (
    <section aria-label="生成信息" className="space-y-3 text-xs text-ui-secondary">
      {!result.success && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-700">
          {result.message || '生成失败'}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-semibold text-ui-text">{clientNames[generation?.target.type || clientType]}</span>
        {generation && <span>{generation.target.version ? `格式核验版本 ${generation.target.version}` : '目标版本未核验'}</span>}
        <span>{generation ? '普通节点' : '节点'} <strong className="text-ui-text">{generation?.nodeCount ?? result.nodeCount}</strong></span>
        {generation && <span>依赖节点 <strong className="text-ui-text">{generation.dependencyNodeCount}</strong></span>}
      </div>
      {!!generation?.dependencyNodes?.length && (
        <ul aria-label="依赖节点" className="divide-y divide-ui-border rounded-xl border border-ui-border px-3">
          {generation.dependencyNodes.map(node => (
            <li key={node.id} className="py-2">
              <span className="font-medium text-ui-text">{node.name}</span>
              {node.sourceName && <span className="ml-2">{node.sourceName}</span>}
              {!!node.reason.length && <span className="mt-1 block break-words text-ui-muted">{node.reason.join(' → ')}</span>}
            </li>
          ))}
        </ul>
      )}
      {generation?.target.mode === 'nodes' && (
        <p className="m-0 text-ui-text">纯节点输出不承载 DoH。</p>
      )}
      {generation && generation.bindings.length > 0 && (
        <div className="divide-y divide-ui-border rounded-xl border border-ui-border">
          {generation.bindings.map(binding => {
            const status = bindingStatus[binding.status];
            const mappedWithoutOutput = !result.success && (binding.status === 'applied' || binding.status === 'degraded');
            return (
              <details key={binding.sourceId} className="group px-3 py-2.5">
                <summary className="cursor-pointer space-y-1.5 marker:text-ui-muted">
                  <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5 align-middle">
                    <span className="font-semibold text-ui-text">{binding.sourceName}</span>
                    <Badge tone={mappedWithoutOutput ? 'neutral' : status.tone}>{mappedWithoutOutput ? '已映射，未输出' : status.label}</Badge>
                    <span>{result.success ? '实际方式' : '映射方式'}：{methodNames[binding.method] || binding.method}</span>
                    <span>{binding.nodeIds.length} 节点</span>
                  </span>
                  <span className="block pl-3.5 text-[11px] text-ui-muted">
                    成功批次 · {batchTime(binding.updatedAt)}
                    {binding.batchId && <code title={binding.batchId} className="ml-2">{binding.batchId.slice(0, 8)}</code>}
                  </span>
                </summary>
                <div className="mt-2.5 space-y-2 border-t border-ui-border pt-2.5 pl-3.5 text-[11px]">
                  <div className="break-all">来源 ID：<code>{binding.sourceId}</code></div>
                  {binding.batchId && <div className="break-all">批次 ID：<code>{binding.batchId}</code></div>}
                  {binding.services.length > 0 && (
                    <ul aria-label={`${binding.sourceName} 的 DoH`} className="space-y-1.5">
                      {binding.services.map(service => (
                        <li key={service.id} className="flex items-start gap-2">
                          <Badge tone={binding.appliedServiceIds.includes(service.id) ? 'success' : 'neutral'} className="shrink-0">
                            {binding.appliedServiceIds.includes(service.id) ? result.success ? '已采用' : '已映射' : '未采用'}
                          </Badge>
                          <span className="min-w-0 break-all">{service.url}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {diagnostics.length > 0 && (
        <ul aria-label="生成诊断" className="space-y-2">
          {diagnostics.map((diagnostic, index) => {
            const source = generation?.bindings.find(binding => binding.sourceId === diagnostic.sourceId);
            return (
              <li key={`${diagnostic.code}-${index}`} className="flex items-start gap-2">
                <Badge tone={diagnostic.severity === 'error' ? 'danger' : 'warning'} className="shrink-0">
                  {diagnostic.severity === 'error' ? '错误' : '警告'}
                </Badge>
                <span className="min-w-0 break-words" title={diagnostic.code}>
                  {source && <span className="font-medium text-ui-text">{source.sourceName}： </span>}
                  {diagnostic.message}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
