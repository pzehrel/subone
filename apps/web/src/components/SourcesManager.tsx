import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { CheckCircle2, Edit2, FileText, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import type { SubscriptionSource } from '../types';
import { formatSubscriptionExpiry, formatSubscriptionTraffic } from '../utils/subscriptionInfo';
import { HelpTooltip } from './HelpTooltip';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import { Badge } from './ui/Badge';
import { Field, Label } from './ui/Field';
import { Textarea } from './ui/Textarea';
import { Input } from './ui/Input';
import { Popconfirm } from './ui/Popconfirm';
import { Select, SelectItem } from './ui/Select';
import { Table, TableCell, TableHead } from './ui/Table';
import { SourcesIcon } from './ui/module-icons';

const panel = 'bg-ui-surface border border-ui-border rounded-2xl shadow-2xs';
const iconButton = 'p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer disabled:opacity-50';
const formatLabels: Record<string, string> = {
  clash: 'Mihomo', mihomo: 'Mihomo', singbox: 'sing-box', quantumultx: 'QuanX',
  base64: 'Base64', uri: 'URI',
};

function previewInfoMatches(source: SubscriptionSource | null, pattern: string) {
  if (!pattern.trim()) return { names: [] as string[], error: '' };
  try {
    const regex = new RegExp(pattern.trim(), 'i');
    return {
      names: [...(source?.nodes || []), ...(source?.infoNodes || [])]
        .filter(node => regex.test(node.originalName || node.name)).map(node => node.originalName || node.name),
      error: '',
    };
  } catch {
    return { names: [] as string[], error: '正则无效，请检查表达式' };
  }
}

interface SourcesManagerProps {
  sources: SubscriptionSource[];
  onAddSource: (source: { name: string; url?: string; acquisition?: 'url' | 'manual'; content?: string; type: string; trafficNodeRegex?: string; expiryNodeRegex?: string }) => Promise<void>;
  onUpdateSource: (id: string, updates: Partial<SubscriptionSource> & { content?: string }) => Promise<void>;
  onDeleteSource: (id: string) => Promise<void>;
  onRefreshSource: (id: string) => Promise<void>;
  onRefreshAllSources: () => Promise<void>;
  onOpenNodes: (sourceId: string) => void;
  onViewRaw: (source: SubscriptionSource) => void;
}

export function SourcesManager({ sources, onAddSource, onUpdateSource, onDeleteSource, onRefreshSource, onRefreshAllSources, onOpenNodes, onViewRaw }: SourcesManagerProps) {
  const upstreams = sources.filter(source => source.acquisition === 'manual' || /^https?:\/\//i.test(source.url || '') && !['custom', 'manual', 'filter'].includes(source.type || ''));
  const [showForm, setShowForm] = useState(false);
  const [editingSource, setEditingSource] = useState<SubscriptionSource | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [acquisition, setAcquisition] = useState<'url' | 'manual'>('url');
  const [content, setContent] = useState('');
  const [replaceContent, setReplaceContent] = useState(false);
  const submitsContent = acquisition === 'manual' && (!editingSource || replaceContent || content !== editingSource.rawSubscription?.content);
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const contentError = contentBytes > 1_048_576 ? '订阅原文不能超过 1 MiB（1,048,576 字节）' : '';
  const [type, setType] = useState('auto');
  const [trafficNodeRegex, setTrafficNodeRegex] = useState('');
  const [expiryNodeRegex, setExpiryNodeRegex] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const trafficMatches = useMemo(() => previewInfoMatches(editingSource, trafficNodeRegex), [editingSource, trafficNodeRegex]);
  const expiryMatches = useMemo(() => previewInfoMatches(editingSource, expiryNodeRegex), [editingSource, expiryNodeRegex]);

  const openForm = (source: SubscriptionSource | null = null, replace = false) => {
    setEditingSource(source);
    setReplaceContent(replace);
    setAcquisition(source?.acquisition || 'url');
    setContent(source?.rawSubscription?.content || '');
    setName(source?.name || '');
    setUrl(source?.url || '');
    setType(source?.type && source.type !== 'remote' ? source.type : 'auto');
    setTrafficNodeRegex(source?.trafficNodeRegex || '');
    setExpiryNodeRegex(source?.expiryNodeRegex || '');
    setFormError('');
    setShowForm(true);
  };

  const saveSource = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !name.trim() || (acquisition === 'url' ? !url.trim() : submitsContent && (!content.trim() || !!contentError)) || trafficMatches.error || expiryMatches.error) return;
    setSubmitting(true);
    setFormError('');
    const updates = { name: name.trim(), acquisition, ...(acquisition === 'url' ? { url: url.trim() } : (submitsContent ? { content } : {})), type, trafficNodeRegex: trafficNodeRegex.trim(), expiryNodeRegex: expiryNodeRegex.trim() };
    try {
      if (editingSource) await onUpdateSource(editingSource.id, updates);
      else await onAddSource(updates);
      setShowForm(false);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存订阅失败');
      if (submitsContent) setReplaceContent(true);
    } finally { setSubmitting(false); }
  };

  const refresh = async (sourceId?: string) => {
    setRefreshing(sourceId || 'all');
    setError('');
    try {
      if (sourceId) await onRefreshSource(sourceId);
      else await onRefreshAllSources();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上游更新失败');
    } finally { setRefreshing(null); }
  };

  const toggleSource = async (source: SubscriptionSource) => {
    setError('');
    try { await onUpdateSource(source.id, { enabled: source.enabled === false }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '更新订阅失败'); }
  };

  const sourceActions = (source: SubscriptionSource) => <div className="ui-table-actions">
    <button className={iconButton} title="查看原文" aria-label={`查看 ${source.name} 原文`} onClick={() => onViewRaw(source)}><FileText size={14} /></button>
    <button className={iconButton} title="更新" aria-label={`更新 ${source.name}`} disabled={!!refreshing} onClick={() => source.acquisition === 'manual' ? openForm(source, true) : refresh(source.id)}><RefreshCw size={14} className={refreshing === source.id || refreshing === 'all' ? 'animate-spin' : ''} /></button>
    <button className={iconButton} title="编辑" aria-label={`编辑 ${source.name}`} onClick={() => openForm(source)}><Edit2 size={14} /></button>
    <button className={iconButton} title={source.enabled !== false ? '停用' : '启用'} aria-label={`${source.enabled !== false ? '停用' : '启用'} ${source.name}`} aria-pressed={source.enabled !== false} onClick={() => toggleSource(source)}>{source.enabled !== false ? <CheckCircle2 size={15} className="text-ui-success" /> : <XCircle size={15} />}</button>
    <Popconfirm title="移除上游？" description="同时删除该上游的解析节点与 DoH 绑定。" danger confirmText="移除" onConfirm={() => onDeleteSource(source.id)}>
      <button className="ui-icon-button-danger p-1.5 rounded-lg" title="移除" aria-label={`移除 ${source.name}`}><Trash2 size={14} /></button>
    </Popconfirm>
  </div>;

  const sourceBadges = (source: SubscriptionSource) => <>
    {source.acquisition === 'manual' && <Badge>手动</Badge>}
    {source.detectedFormat && <Badge tone="info">{formatLabels[source.detectedFormat] || source.detectedFormat}</Badge>}
    {source.enabled === false && <Badge>已停用</Badge>}
    {source.lastUpdateError && <Badge tone="danger">更新失败</Badge>}
  </>;

  return <div className="max-w-6xl mx-auto space-y-5 pb-16">
    <section className={`${panel} p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5`}>
      <div className="flex items-center gap-2"><SourcesIcon className="w-5 h-5 text-ui-accent" /><h1 className="text-base font-bold">上游订阅</h1><Badge tone="accent" className="font-mono border">{upstreams.length}</Badge></div>
      <div className="flex items-center gap-2 flex-wrap">
        <button className="ui-button-secondary" disabled={!!refreshing || !upstreams.length} onClick={() => refresh()}><RefreshCw size={14} className={refreshing === 'all' ? 'animate-spin' : ''} />更新全部</button>
        <button className="ui-button-primary" onClick={() => openForm()}><Plus size={14} />添加订阅</button>
      </div>
    </section>
    {error && <p role="alert" className="rounded-xl bg-ui-danger-soft p-3 text-xs text-ui-danger">{error}</p>}
    <section className={`${panel} overflow-hidden`}>
      <div className="hidden sm:block"><Table label="上游订阅列表">
        <thead><tr><TableHead>订阅</TableHead><TableHead>节点</TableHead><TableHead>用量</TableHead><TableHead>到期时间</TableHead><TableHead fixed="right" className="text-right">操作</TableHead></tr></thead>
        <tbody>{upstreams.map(source => <tr key={source.id}>
          <TableCell minWidth={215} maxWidth={460}>
            <div className="flex flex-wrap items-center gap-2"><span className={`text-xs font-bold ${source.enabled === false ? 'text-ui-muted' : ''}`}>{source.name}</span>{sourceBadges(source)}</div>
            <div className="text-[10px] text-ui-muted font-mono mt-1 break-all">{source.acquisition === 'manual' ? (source.lastUpdated ? `上次成功 ${new Date(source.lastUpdated).toLocaleString()}` : '尚未成功更新') : source.url}</div>
            {source.lastUpdateError && <p className="text-[10px] text-ui-danger mt-1">{source.lastUpdateError}</p>}
          </TableCell>
          <TableCell minWidth={65}><button className="text-xs text-ui-accent hover:underline cursor-pointer" aria-label={`查看 ${source.name} 的节点`} onClick={() => onOpenNodes(source.id)}>{source.nodes?.length ?? source.nodeCount ?? 0} 节点</button></TableCell>
          <TableCell minWidth={110}><span className="text-[11px] text-ui-secondary">{formatSubscriptionTraffic(source.subscriptionInfo) || '—'}</span></TableCell>
          <TableCell minWidth={100}><span className="text-[11px] text-ui-secondary">{formatSubscriptionExpiry(source.subscriptionInfo) || '—'}</span></TableCell>
          <TableCell fixed="right" className="text-right">{sourceActions(source)}</TableCell>
        </tr>)}</tbody>
      </Table></div>
      <div className="sm:hidden divide-y divide-ui-divider">{upstreams.map(source => <article key={source.id} className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-xs font-bold break-all">{source.name}</h2>{sourceBadges(source)}</div>
        <p className="text-[10px] font-mono text-ui-muted break-all">{source.acquisition === 'manual' ? (source.lastUpdated ? `上次成功 ${new Date(source.lastUpdated).toLocaleString()}` : '尚未成功更新') : source.url}</p>
        {source.lastUpdateError && <p className="text-[10px] text-ui-danger">{source.lastUpdateError}</p>}
        <div className="flex items-start justify-between gap-3 text-[11px]">
          <button className="text-ui-accent cursor-pointer" aria-label={`查看 ${source.name} 的节点`} onClick={() => onOpenNodes(source.id)}>{source.nodes?.length ?? source.nodeCount ?? 0} 节点</button>
          <div className="text-right text-ui-secondary"><p>{formatSubscriptionTraffic(source.subscriptionInfo) || '—'}</p><p className="text-ui-muted text-[10px] mt-1">到期 {formatSubscriptionExpiry(source.subscriptionInfo) || '—'}</p></div>
        </div>
        <div className="flex justify-end border-t border-ui-divider pt-3">{sourceActions(source)}</div>
      </article>)}</div>
      {!upstreams.length && <p className="p-10 text-center text-xs text-ui-muted">暂无上游订阅</p>}
    </section>

    <Modal open={showForm} title={editingSource ? '编辑上游订阅' : '添加上游订阅'} size="lg" onClose={() => { if (!submitting) setShowForm(false); }}>
      <ModalForm onSubmit={saveSource}>
        <ModalBody>
          {formError && <p role="alert" className="text-xs text-ui-danger">{formError}</p>}
          <Field><Label>订阅名称</Label><Input required value={name} onChange={event => setName(event.target.value)} /></Field>
          {!editingSource && <Field><Label>输入方式</Label><Select value={acquisition} onValueChange={value => setAcquisition(value as 'url' | 'manual')}><SelectItem value="url">订阅地址</SelectItem><SelectItem value="manual">粘贴原文</SelectItem></Select></Field>}
          {acquisition === 'manual' ? <Field><Label>订阅原文</Label><Textarea required={submitsContent} rows={9} value={content} onChange={event => setContent(event.target.value)} aria-invalid={!!contentError} className="font-mono" /><p className={`mt-1 text-[11px] ${contentError ? 'text-ui-danger' : 'text-ui-muted'}`} role={contentError ? 'alert' : undefined}>{contentError || `${contentBytes.toLocaleString()} / 1,048,576 字节`}</p></Field> : <>
          <Field><Label>订阅地址</Label><Input type="url" required placeholder="https://example.com/subscription" value={url} onChange={event => setUrl(event.target.value)} /></Field>
          <Field><Label>内容格式</Label><Select value={type} onValueChange={setType}>
            <SelectItem value="auto">自动识别</SelectItem><SelectItem value="clash">Mihomo / Clash YAML</SelectItem><SelectItem value="singbox">sing-box JSON</SelectItem><SelectItem value="quantumultx">Quantumult X</SelectItem><SelectItem value="base64">Base64 节点串</SelectItem>
          </Select></Field>
          </>}
          {[
            { id: 'traffic-node-regex', label: '流量信息匹配', placeholder: '剩余流量|已用流量|流量用量', value: trafficNodeRegex, setValue: setTrafficNodeRegex, preview: trafficMatches },
            { id: 'expiry-node-regex', label: '到期信息匹配', placeholder: '套餐到期|到期时间|有效期', value: expiryNodeRegex, setValue: setExpiryNodeRegex, preview: expiryMatches },
          ].map(field => <Field id={field.id} key={field.id}>
            <div className="mb-1 flex items-center gap-1"><Label>{field.label}</Label><HelpTooltip label={`${field.label}说明`} content="按节点名称匹配信息。匹配项不计入可用节点，留空则不匹配。" /></div>
            <Input value={field.value} onChange={event => field.setValue(event.target.value)} placeholder={field.placeholder} aria-invalid={!!field.preview.error} aria-describedby={`${field.id}-preview`} className="font-mono" />
            <div id={`${field.id}-preview`} className={`mt-1 text-[11px] ${field.preview.error ? 'text-ui-danger' : 'text-ui-secondary'}`}>
              {field.preview.error || (field.value.trim() && (editingSource ? `匹配 ${field.preview.names.length} 项` : '保存后匹配'))}
              {!!field.preview.names.length && <ul className="mt-1 max-h-20 overflow-y-auto space-y-1 break-words">{field.preview.names.map((nodeName, index) => <li key={index}>{nodeName}</li>)}</ul>}
            </div>
          </Field>)}
        </ModalBody>
        <ModalFooter><button type="button" className="ui-button-secondary" disabled={submitting} onClick={() => setShowForm(false)}>取消</button><button type="submit" className="ui-button-primary" disabled={submitting || !!contentError || !!trafficMatches.error || !!expiryMatches.error}>{submitting ? '保存中…' : editingSource ? '保存更改' : acquisition === 'manual' ? '添加' : '添加并拉取'}</button></ModalFooter>
      </ModalForm>
    </Modal>
  </div>;
}
