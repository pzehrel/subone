import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, CheckCircle2, ChevronDown, Copy, Edit2, RefreshCw, Server, XCircle } from 'lucide-react';
import type { ProxyNode, SubscriptionSource } from '../types';
import { copyToClipboard } from '../utils/clipboard';
import { nodeToUri } from '../utils/nodeUri';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import { Badge } from './ui/Badge';
import { Field, Label } from './ui/Field';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';

const iconButton = 'p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer disabled:opacity-50';

interface NodesManagerProps {
  sources: SubscriptionSource[];
  focusSourceId?: string | null;
  onUpdateNode: (id: string, updates: { name?: string; enabled?: boolean }) => Promise<void>;
  onRefreshSource: (id: string) => Promise<void>;
}

export function NodesManager({ sources, focusSourceId, onUpdateNode, onRefreshSource }: NodesManagerProps) {
  const upstreams = sources.filter(source => /^https?:\/\//i.test(source.url || '') && !['custom', 'manual', 'filter'].includes(source.type || ''));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusSourceId ? [focusSourceId] : []));
  const sourceElements = useRef(new Map<string, HTMLElement>());
  const [editingNode, setEditingNode] = useState<ProxyNode | null>(null);
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [copiedNode, setCopiedNode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const totalNodes = upstreams.reduce((total, source) => total + (source.nodes?.length || 0), 0);

  useEffect(() => {
    if (!focusSourceId) return;
    const frame = requestAnimationFrame(() => {
      const element = sourceElements.current.get(focusSourceId);
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      element?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSourceId]);

  const toggleGroup = (sourceId: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    return next;
  });

  const openNode = (node: ProxyNode) => {
    setEditingNode(node);
    setName(node.name);
    setEnabled(node.enabled !== false);
    setFormError('');
  };

  const copyNode = async (node: ProxyNode) => {
    const text = nodeToUri(node);
    if (await copyToClipboard(text)) {
      setCopiedNode(node.id);
      window.setTimeout(() => setCopiedNode(current => current === node.id ? null : current), 1500);
    } else {
      if (editingNode) setFormError('复制失败，请手动选择连接链接复制');
      else setError('复制失败，请打开节点设置复制连接链接');
    }
  };

  const saveNode = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingNode || busyNode || !name.trim()) return;
    setBusyNode(editingNode.id);
    setFormError('');
    try {
      await onUpdateNode(editingNode.id, { name: name.trim(), enabled });
      setEditingNode(null);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存本地设置失败');
    } finally { setBusyNode(null); }
  };

  const toggleNode = async (node: ProxyNode) => {
    setBusyNode(node.id);
    setError('');
    try { await onUpdateNode(node.id, { enabled: node.enabled === false }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '更新节点失败'); }
    finally { setBusyNode(null); }
  };

  const refreshSource = async (sourceId: string) => {
    setRefreshing(sourceId);
    setError('');
    try { await onRefreshSource(sourceId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '上游更新失败'); }
    finally { setRefreshing(null); }
  };

  return <div className="max-w-6xl mx-auto space-y-5 pb-16">
    <section className="bg-ui-surface border border-ui-border rounded-2xl shadow-2xs p-4 flex items-center gap-2">
      <Server className="w-5 h-5 text-ui-accent" /><h1 className="text-base font-bold">节点</h1><Badge tone="accent" className="font-mono border">{totalNodes}</Badge>
    </section>
    {error && <p role="alert" className="rounded-xl bg-ui-danger-soft p-3 text-xs text-ui-danger">{error}</p>}
    <div className="space-y-3">{upstreams.map(source => {
      const nodes = source.nodes || [];
      const isExpanded = expanded.has(source.id);
      const updated = source.lastUpdated ? new Date(source.lastUpdated) : null;
      return <article
        key={source.id}
        id={`node-source-${source.id}`}
        ref={element => { if (element) sourceElements.current.set(source.id, element); else sourceElements.current.delete(source.id); }}
        tabIndex={-1}
        className={`scroll-mt-20 rounded-2xl border bg-ui-surface overflow-hidden shadow-2xs transition-all focus:outline-none focus:ring-2 focus:ring-ui-accent/30 ${isExpanded ? 'border-ui-accent/60' : 'border-ui-border hover:border-ui-accent/40'} ${source.enabled === false ? 'opacity-65' : ''}`}
      >
        <div className={`p-4 flex items-start justify-between gap-3 ${isExpanded ? 'bg-ui-subtle' : ''}`}>
          <button className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer" aria-label={`${isExpanded ? '收起' : '展开'} ${source.name}`} aria-expanded={isExpanded} aria-controls={`source-nodes-${source.id}`} onClick={() => toggleGroup(source.id)}>
            <ChevronDown size={16} className={`shrink-0 text-ui-muted transition-transform ${isExpanded ? 'rotate-180 text-ui-accent' : ''}`} />
            <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
              <h2 className="text-xs font-bold truncate" title={source.name}>{source.name}</h2><Badge className="font-mono shrink-0">{nodes.length} 节点</Badge>{source.enabled === false && <Badge className="shrink-0">已停用</Badge>}
              <span className="ml-auto shrink-0 text-[10px] font-normal text-ui-muted whitespace-nowrap">最后更新 {updated && Number.isFinite(updated.getTime()) ? <time dateTime={source.lastUpdated} title={updated.toLocaleString()}>{updated.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time> : '—'}</span>
            </div>
          </button>
          <button className={`${iconButton} shrink-0 -mt-1`} title="更新上游" aria-label={`更新 ${source.name}`} disabled={!!refreshing} onClick={() => refreshSource(source.id)}><RefreshCw size={14} className={`text-ui-accent ${refreshing === source.id ? 'animate-spin' : ''}`} /></button>
        </div>
        {isExpanded && <div id={`source-nodes-${source.id}`} className="border-t border-ui-divider divide-y divide-ui-divider">{nodes.map(node => <div key={node.id} className={`px-4 py-2 hover:bg-ui-subtle flex items-center justify-between gap-3 text-xs ${node.enabled === false ? 'opacity-55' : ''}`}>
          <div className="flex items-center gap-2.5 min-w-0 flex-1"><span className="text-sm shrink-0">{node.countryEmoji || '🌐'}</span>
            <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
              <button className="text-left font-bold truncate max-w-md cursor-pointer" title={node.name} onClick={() => openNode(node)}>{node.name}</button>
              <div className="flex items-center gap-1.5 min-w-0"><Badge className="font-mono shrink-0">{node.type.toUpperCase()}</Badge><span className="text-[11px] font-mono text-ui-muted truncate">{node.server}:{node.port}</span>{node.enabled === false && <Badge className="shrink-0">已禁用</Badge>}</div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button className={iconButton} title="复制连接链接" aria-label={`复制 ${node.name} 连接链接`} onClick={() => copyNode(node)}>{copiedNode === node.id ? <Check size={14} className="text-ui-success" /> : <Copy size={14} />}</button>
            <button className={iconButton} title="节点设置" aria-label={`设置 ${node.name}`} onClick={() => openNode(node)}><Edit2 size={14} /></button>
            <button className={iconButton} title={node.enabled === false ? '启用' : '禁用'} aria-label={`${node.enabled === false ? '启用' : '禁用'} ${node.name}`} aria-pressed={node.enabled !== false} disabled={!!busyNode} onClick={() => toggleNode(node)}>{node.enabled !== false ? <CheckCircle2 size={15} className="text-ui-success" /> : <XCircle size={15} />}</button>
          </div>
        </div>)}{!nodes.length && <p className="p-6 text-center text-xs text-ui-muted">暂无节点</p>}</div>}
      </article>;
    })}</div>
    {!upstreams.length && <p className="p-6 text-center text-xs text-ui-muted">暂无节点</p>}

    <Modal open={!!editingNode} title="节点设置" size="lg" onClose={() => { if (!busyNode) setEditingNode(null); }}>
      {editingNode && <ModalForm onSubmit={saveNode}>
        <ModalBody>
          {formError && <p role="alert" className="text-xs text-ui-danger">{formError}</p>}
          <Field><Label>本地名称</Label><Input required value={name} onChange={event => setName(event.target.value)} /></Field>
          <Field><Label>服务器地址</Label><Input value={editingNode.server} readOnly /></Field>
          <div className="grid grid-cols-2 gap-3"><Field><Label>端口</Label><Input value={editingNode.port} readOnly /></Field><Field><Label>协议</Label><Input value={editingNode.type.toUpperCase()} readOnly /></Field></div>
          <Field><div className="flex items-center justify-between"><Label>连接链接</Label><button type="button" className={iconButton} title="复制连接链接" aria-label="复制连接链接" onClick={() => copyNode(editingNode)}>{copiedNode === editingNode.id ? <Check size={14} className="text-ui-success" /> : <Copy size={14} />}</button></div><Textarea variant="code" rows={4} value={nodeToUri(editingNode)} readOnly /></Field>
          <label className="flex items-center gap-2 text-xs"><Input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用节点</label>
        </ModalBody>
        <ModalFooter><button type="button" className="ui-button-secondary" disabled={!!busyNode} onClick={() => setEditingNode(null)}>取消</button><button type="submit" className="ui-button-primary" disabled={!!busyNode}>{busyNode ? '保存中…' : '保存本地设置'}</button></ModalFooter>
      </ModalForm>}
    </Modal>
  </div>;
}
