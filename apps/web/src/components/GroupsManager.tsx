import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Code, Edit2, Plus, Trash2, X } from 'lucide-react';
import * as yaml from 'js-yaml';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import { Badge } from './ui/Badge';
import { Field, Label } from './ui/Field';
import { Input } from './ui/Input';
import { Popconfirm } from './ui/Popconfirm';
import { Select, SelectItem } from './ui/Select';
import { Table, TableCell, TableHead } from './ui/Table';
import { Textarea } from './ui/Textarea';
import { GroupsIcon } from './ui/module-icons';
import type { ProxyGroupItem, ProxyNode, SourceIconsConfig, SubscriptionSource } from '../types';

interface GroupsManagerProps {
  groups: ProxyGroupItem[];
  sources?: SubscriptionSource[];
  nodes?: ProxyNode[];
  sourceIcons?: SourceIconsConfig;
  onAddGroup: (group: Partial<ProxyGroupItem>) => Promise<void>;
  onUpdateGroup: (id: string, group: Partial<ProxyGroupItem>) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onBatchImportGroups: (text: string, replaceAll?: boolean) => Promise<void>;
}

const panel = 'bg-ui-surface border border-ui-border rounded-2xl shadow-2xs';
const iconButton = 'p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer';
const typeLabels: Record<ProxyGroupItem['type'], string> = {
  select: 'select', urltest: 'url-test', fallback: 'fallback', 'load-balance': 'load-balance', relay: 'relay', direct: 'direct', reject: 'reject',
};
const initialForm: Partial<ProxyGroupItem> = {
  name: '', type: 'select', proxies: [], use: [], sources: [], filter: '',
  tolerance: 50, url: 'https://www.google.com/generate_204', interval: 300,
};

const cleanName = (name: string, icons?: SourceIconsConfig) => {
  let value = name;
  for (const icon of [icons?.custom, icons?.filter, icons?.remote]) {
    if (icon && value.startsWith(icon)) value = value.slice(icon.length).trim();
  }
  return value.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim().toLowerCase();
};

export function GroupsManager({ groups, sources = [], nodes = [], sourceIcons, onAddGroup, onUpdateGroup, onDeleteGroup, onBatchImportGroups }: GroupsManagerProps) {
  const [editor, setEditor] = useState<ProxyGroupItem | 'new' | null>(null);
  const [form, setForm] = useState<Partial<ProxyGroupItem>>(initialForm);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const savePending = useRef(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState('');
  const [yamlSaving, setYamlSaving] = useState(false);
  const yamlPending = useRef(false);
  const preview = groups.find(group => group.id === previewId);
  const sourceFor = (value: string) => sources.find(source => source.id === value)
    || sources.find(source => source.name === value);
  const activeNodes = nodes.filter(node => node.enabled !== false && sources.some(source => source.id === node.sourceId && source.enabled));
  const savedNodes = new Map(sources.flatMap(source => [...(source.nodes || []), ...(source.infoNodes || [])]).map(node => [node.id, node]));
  activeNodes.forEach(node => savedNodes.set(node.id, node));
  const activeIds = new Set(activeNodes.map(node => node.id));
  const nodeLabel = (node: ProxyNode) => {
    const source = sources.find(source => source.id === node.sourceId);
    return `${node.name} · ${source?.name || node.sourceName || node.sourceId || '未知来源'}`;
  };
  const outbound = (value: string) => {
    if (value.startsWith('node:')) {
      const node = savedNodes.get(value.slice(5));
      return { value, label: node ? nodeLabel(node) : value, available: !!node && activeIds.has(node.id), kind: 'node' };
    }
    const group = value.startsWith('group:') ? groups.find(group => group.id === value.slice(6)) : groups.find(group => group.name === value);
    if (group) return { value, label: group.name, available: true, kind: 'group' };
    const builtin = /^(direct|reject|block|pass|global|reject-drop|compatible|🎯 本地直连)$/i.test(value);
    return { value, label: value, available: builtin, kind: builtin ? 'builtin' : 'unavailable' };
  };
  const outboundKey = (value: string) => {
    const group = value.startsWith('group:') ? groups.find(group => group.id === value.slice(6)) : groups.find(group => group.name === value);
    return group ? `group:${group.id}` : /^(direct|reject)$/i.test(value) ? value.toUpperCase() : value;
  };
  const candidates = [
    ...groups.filter(group => editor === 'new' || group.id !== editor?.id).map(group => ({ value: `group:${group.id}`, label: group.name })),
    ...['DIRECT', 'REJECT'].map(value => ({ value, label: value })),
    ...activeNodes.map(node => ({ value: `node:${node.id}`, label: nodeLabel(node) })),
  ];
  const isTerminal = (group: ProxyGroupItem) => group.type === 'direct' || group.type === 'reject';
  const implicitSource = (group: ProxyGroupItem) => sources.find(source => cleanName(source.name, sourceIcons) === cleanName(group.name, sourceIcons));
  const matchesNodeSource = (group: ProxyGroupItem) => !isTerminal(group) && (!!(group.sources ?? group.use)?.length || !!group.filter || !!group.includeAll || !!implicitSource(group) || ['♻️ 自动选择', '👉 手动选择'].includes(group.name));
  // This preview shows direct active matches. Referenced groups are never expanded here.
  const matchedNodes = (group: ProxyGroupItem) => {
    if (isTerminal(group)) return [];
    const mounts = group.sources ?? group.use ?? [];
    const selectedSources = new Set(mounts.map(value => sourceFor(value)?.id).filter(Boolean));
    const implicit = implicitSource(group);
    let dynamic = matchesNodeSource(group) ? activeNodes : [];
    if (mounts.length) dynamic = dynamic.filter(node => selectedSources.has(node.sourceId));
    else if (implicit && !group.filter && !group.includeAll) dynamic = dynamic.filter(node => node.sourceId === implicit.id);
    if (group.filter) {
      try {
        const regex = new RegExp(group.filter.replace(/\(\?i\)/g, ''), 'i');
        dynamic = dynamic.filter(node => regex.test(node.name));
      } catch { dynamic = []; }
    }
    const explicit = new Set((group.proxies || []).filter(value => value.startsWith('node:')).map(value => value.slice(5)));
    const dynamicIds = new Set(dynamic.map(node => node.id));
    return activeNodes.filter(node => explicit.has(node.id) || dynamicIds.has(node.id));
  };
  const sourceNames = (group: ProxyGroupItem) => (group.sources ?? group.use ?? []).map(value => {
    const source = sourceFor(value);
    return `${source?.name || value}${source?.enabled ? '' : ' · 不可用'}`;
  });
  const closeEditor = () => { if (!savePending.current) setEditor(null); };
  const closeYaml = () => { if (!yamlPending.current) setYamlOpen(false); };
  const openEditor = (group?: ProxyGroupItem) => {
    setFormError('');
    if (group) {
      const mounts = [...(group.sources ?? group.use ?? [])];
      setForm({ ...group, proxies: [...(group.proxies || [])], sources: mounts, use: [...mounts] });
      setEditor(group);
    } else {
      setForm({ ...initialForm, proxies: [], sources: [], use: [] });
      setEditor('new');
    }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savePending.current) return;
    if (form.filter) {
      try { new RegExp(form.filter.replace(/\(\?i\)/g, ''), 'i'); }
      catch { setFormError('节点过滤正则无效'); return; }
    }
    const mounts = [...(form.sources ?? form.use ?? [])];
    const payload = { ...form, name: form.name?.trim(), proxies: [...(form.proxies || [])], sources: mounts, use: [...mounts], filter: form.filter?.trim() || '' };
    savePending.current = true;
    setSaving(true);
    setFormError('');
    try {
      if (editor && editor !== 'new') await onUpdateGroup(editor.id, payload);
      else await onAddGroup(payload);
      setEditor(null);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      savePending.current = false;
      setSaving(false);
    }
  };
  const removeProxy = (value: string) => setForm(current => ({ ...current, proxies: (current.proxies || []).filter(item => item !== value) }));
  const toggleProxy = (value: string) => setForm(current => ({ ...current, proxies: (current.proxies || []).some(item => outboundKey(item) === value) ? (current.proxies || []).filter(item => outboundKey(item) !== value) : [...(current.proxies || []), value] }));
  const moveProxy = (index: number, direction: number) => {
    const values = [...(form.proxies || [])];
    const next = index + direction;
    if (next < 0 || next >= values.length) return;
    [values[index], values[next]] = [values[next], values[index]];
    setForm({ ...form, proxies: values });
  };
  const removeSource = (value: string) => {
    const next = (form.sources ?? form.use ?? []).filter(item => item !== value);
    setForm({ ...form, sources: next, use: [...next] });
  };
  const toggleSource = (source: SubscriptionSource) => {
    const values = form.sources ?? form.use ?? [];
    const selected = values.some(value => sourceFor(value)?.id === source.id);
    const next = selected ? values.filter(value => sourceFor(value)?.id !== source.id) : [...values, source.id];
    setForm({ ...form, sources: next, use: [...next] });
  };
  const openYaml = () => {
    setYamlError('');
    setYamlText(yaml.dump({ 'proxy-groups': groups.map(group => {
      const entry = { ...group };
      const mounts = group.sources ?? group.use;
      return { ...entry, ...(mounts ? { sources: [...mounts], use: [...mounts] } : {}) };
    }) }, { indent: 2, lineWidth: -1 }));
    setYamlOpen(true);
  };
  const saveYaml = async () => {
    if (yamlPending.current) return;
    yamlPending.current = true;
    setYamlSaving(true);
    setYamlError('');
    try {
      await onBatchImportGroups(yamlText, true);
      setYamlOpen(false);
    } catch (cause) {
      setYamlError(cause instanceof Error ? cause.message : '应用失败');
    } finally {
      yamlPending.current = false;
      setYamlSaving(false);
    }
  };

  const typeBadge = (group: ProxyGroupItem) => <Badge tone={group.type === 'urltest' ? 'success' : group.type === 'relay' ? 'info' : 'neutral'} className="font-mono">{typeLabels[group.type] || group.type}</Badge>;
  const composition = (group: ProxyGroupItem) => isTerminal(group) ? <span className="text-ui-secondary text-xs">{group.type === 'direct' ? 'DIRECT' : 'REJECT'}</span> : <div className="space-y-1.5 min-w-0">
    {sourceNames(group).length > 0 && <div className="flex flex-wrap gap-1">{sourceNames(group).map((name, index) => <Badge key={index} className="max-w-full"><span className="truncate" title={name}>{name}</span></Badge>)}</div>}
    {(group.proxies || []).length > 0 && <div className="flex flex-wrap items-center gap-1 text-[11px] text-ui-secondary">{group.proxies!.map((value, index) => <span className="inline-flex items-center gap-1 min-w-0 max-w-full" key={index}>{group.type === 'relay' && index > 0 && <ChevronRight size={12} className="shrink-0 text-ui-muted" />}<span className="truncate" title={outbound(value).label}>{outbound(value).label}{!outbound(value).available && ' · 不可用'}</span>{group.type !== 'relay' && index < group.proxies!.length - 1 && <span className="text-ui-muted">、</span>}</span>)}</div>}
    {group.filter && <div className="flex items-center gap-1.5 text-[10px] text-ui-muted"><span className="shrink-0">正则</span><code className="truncate font-mono" title={group.filter}>{group.filter}</code></div>}
    {!sourceNames(group).length && !group.proxies?.length && !group.filter && <span className="text-ui-muted text-xs">{group.type === 'direct' ? 'DIRECT' : group.type === 'reject' ? 'REJECT' : '—'}</span>}
  </div>;
  const previewButton = (group: ProxyGroupItem) => <button className="text-xs text-ui-accent hover:underline cursor-pointer whitespace-nowrap" aria-label={`预览 ${group.name}`} onClick={() => setPreviewId(group.id)}>{matchesNodeSource(group) || matchedNodes(group).length ? `${matchedNodes(group).length} 节点` : '查看出站'}</button>;
  const actions = (group: ProxyGroupItem) => <div className="ui-table-actions">
    <button className={iconButton} title="编辑" aria-label={`编辑 ${group.name}`} onClick={() => openEditor(group)}><Edit2 size={14} /></button>
    <Popconfirm title="删除策略组？" description={group.name} confirmText="删除" danger onConfirm={() => onDeleteGroup(group.id)}><button className="ui-icon-button-danger p-1.5 rounded-lg" title="删除" aria-label={`删除 ${group.name}`}><Trash2 size={14} /></button></Popconfirm>
  </div>;

  return <div className="space-y-5">
    <section className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 p-4 ${panel}`}>
      <div className="flex items-center gap-2"><GroupsIcon className="w-5 h-5 text-ui-accent" /><h1 className="text-base font-bold">策略组</h1><Badge tone="accent" className="font-mono border">{groups.length} 个策略组</Badge></div>
      <div className="flex items-center gap-2"><button className="ui-button-secondary" onClick={openYaml}><Code size={14} />YAML 编辑</button><button className="ui-button-primary" onClick={() => openEditor()}><Plus size={14} />新建策略组</button></div>
    </section>
    <section className={`${panel} overflow-hidden`}>
      <div className="hidden sm:block"><Table label="策略组列表"><thead><tr><TableHead>策略组</TableHead><TableHead>类型</TableHead><TableHead>来源 / 出站</TableHead><TableHead>节点</TableHead><TableHead fixed="right" className="text-right">操作</TableHead></tr></thead><tbody>{groups.map(group => <tr key={group.id}>
        <TableCell minWidth={180} maxWidth={260}><button className="block max-w-full truncate text-xs font-bold text-left hover:text-ui-accent cursor-pointer" title={group.name} onClick={() => setPreviewId(group.id)}>{group.name}</button></TableCell>
        <TableCell minWidth={95}>{typeBadge(group)}</TableCell>
        <TableCell minWidth={220} maxWidth={380}>{composition(group)}</TableCell>
        <TableCell minWidth={70}>{previewButton(group)}</TableCell>
        <TableCell fixed="right" className="text-right">{actions(group)}</TableCell>
      </tr>)}</tbody></Table></div>
      <div className="sm:hidden divide-y divide-ui-divider">{groups.map(group => <article key={group.id} className="p-4 space-y-3 min-w-0">
        <div className="flex items-start justify-between gap-3"><button className="min-w-0 text-left text-xs font-bold break-all hover:text-ui-accent cursor-pointer" onClick={() => setPreviewId(group.id)}>{group.name}</button><span className="shrink-0">{typeBadge(group)}</span></div>
        {composition(group)}
        <div className="border-t border-ui-divider pt-2.5 flex items-center justify-between">{previewButton(group)}{actions(group)}</div>
      </article>)}</div>
      {!groups.length && <p className="p-12 text-center text-xs text-ui-muted">暂无策略组</p>}
    </section>

    <Modal open={editor !== null} title={editor === 'new' ? '新建策略组' : '编辑策略组'} size="lg" onClose={closeEditor}>
      {editor && <ModalForm onSubmit={save}><ModalBody>
        <div className="grid sm:grid-cols-2 gap-3.5">
          <Field><Label>策略组名称</Label><Input required value={form.name || ''} onChange={event => setForm({ ...form, name: event.target.value })} /></Field>
          <Field><Label>策略类型</Label><Select value={form.type || 'select'} onValueChange={value => setForm({ ...form, type: value as ProxyGroupItem['type'] })}>
            <SelectItem value="select">select · 手动选择</SelectItem><SelectItem value="urltest">url-test · 自动测速</SelectItem><SelectItem value="fallback">fallback · 故障切换</SelectItem><SelectItem value="load-balance">load-balance · 负载均衡</SelectItem><SelectItem value="relay">relay · 链式中继</SelectItem><SelectItem value="direct">direct · 直连</SelectItem><SelectItem value="reject">reject · 拒绝</SelectItem>
          </Select></Field>
        </div>
        <Field><Label>出站</Label>
          <div className="space-y-3 rounded-xl border border-ui-border p-3">
            <div className="flex flex-wrap gap-1.5 min-h-6">{(form.proxies || []).map((value, index) => <Badge key={value} tone={form.type === 'relay' ? 'info' : 'accent'} className="max-w-full">
              {form.type === 'relay' && <span className="shrink-0 text-[10px]">{index + 1}.</span>}<span className="truncate max-w-56" title={outbound(value).label}>{outbound(value).label}{!outbound(value).available && ' · 不可用'}</span>
              {form.type === 'relay' && <><button type="button" className="cursor-pointer disabled:opacity-30" aria-label={`提前 ${outbound(value).label}`} disabled={index === 0} onClick={() => moveProxy(index, -1)}><ArrowLeft size={12} /></button><button type="button" className="cursor-pointer disabled:opacity-30" aria-label={`延后 ${outbound(value).label}`} disabled={index === (form.proxies || []).length - 1} onClick={() => moveProxy(index, 1)}><ArrowRight size={12} /></button></>}
              <button type="button" className="cursor-pointer" aria-label={`移除出站 ${outbound(value).label}`} onClick={() => removeProxy(value)}><X size={12} /></button>
            </Badge>)}{!form.proxies?.length && <span className="text-xs text-ui-muted">未选择出站</span>}</div>
            {form.type === 'relay' && <p className="text-[11px] text-ui-secondary">按顺序中继，首项为入口，末项为出口。</p>}
            <div className="flex flex-wrap gap-1.5 border-t border-ui-divider pt-3">{candidates.map(candidate => {
              const selected = (form.proxies || []).some(value => outboundKey(value) === candidate.value);
              return <button type="button" key={candidate.value} aria-pressed={selected} aria-label={`出站 ${candidate.label}`} onClick={() => toggleProxy(candidate.value)} className={`flex items-center gap-1 max-w-full rounded-lg border px-2 py-1 text-[11px] cursor-pointer ${selected ? 'border-ui-accent bg-ui-accent/10 text-ui-accent' : 'border-ui-border text-ui-secondary hover:border-ui-accent/60'}`}><span className="shrink-0">{selected ? <Check size={12} /> : <Plus size={12} />}</span><span className="truncate" title={candidate.label}>{candidate.label}</span></button>;
            })}</div>
          </div>
        </Field>
        {(sources.length > 0 || (form.sources ?? form.use)?.length) && <Field><Label>上游订阅</Label>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">{(form.sources ?? form.use ?? []).map(value => {
              const source = sourceFor(value);
              const label = source?.name || value;
              return <Badge key={value} tone={source?.enabled ? 'accent' : 'warning'} className="max-w-full"><span className="truncate" title={label}>{label}{!source?.enabled && ' · 不可用'}</span><button type="button" aria-label={`移除来源 ${label}`} onClick={() => removeSource(value)}><X size={12} /></button></Badge>;
            })}</div>
            <div className="flex flex-wrap gap-2">{sources.filter(source => source.enabled).map(source => {
              const selected = (form.sources ?? form.use ?? []).some(value => sourceFor(value)?.id === source.id);
              return <button type="button" key={source.id} aria-label={`来源 ${source.name}`} aria-pressed={selected} onClick={() => toggleSource(source)} className={`max-w-full flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer ${selected ? 'border-ui-accent bg-ui-accent/10 text-ui-accent' : 'border-ui-border text-ui-secondary hover:border-ui-accent/60'}`}><span className="truncate" title={source.name}>{source.name}</span><span className="shrink-0 text-[10px] opacity-80">{activeNodes.filter(node => node.sourceId === source.id).length}</span>{selected && <Check size={12} className="shrink-0" />}</button>;
            })}</div>
          </div>
        </Field>}
        <Field><Label>节点过滤正则</Label><Input className="font-mono" value={form.filter || ''} onChange={event => setForm({ ...form, filter: event.target.value })} /></Field>
        {(form.type === 'urltest' || form.type === 'fallback') && <div className="grid grid-cols-2 gap-3.5">
          <Field className="col-span-2"><Label>测速 URL</Label><Input type="url" value={form.url ?? ''} onChange={event => setForm({ ...form, url: event.target.value })} /></Field>
          <Field><Label>测速容差（ms）</Label><Input type="number" min={0} value={form.tolerance ?? 50} onChange={event => setForm({ ...form, tolerance: Number(event.target.value) })} /></Field>
          <Field><Label>测速间隔（秒）</Label><Input type="number" min={0} value={form.interval ?? 300} onChange={event => setForm({ ...form, interval: Number(event.target.value) })} /></Field>
        </div>}
        {formError && <p role="alert" className="text-xs text-ui-danger">{formError}</p>}
      </ModalBody><ModalFooter><button type="button" className="ui-button-secondary" disabled={saving} onClick={closeEditor}>取消</button><button disabled={saving} className="ui-button-primary">{saving ? '保存中...' : '保存'}</button></ModalFooter></ModalForm>}
    </Modal>

    <Modal open={!!preview} title={preview?.name || '策略组'} size="lg" onClose={() => setPreviewId(null)}>
      {preview && <><ModalBody>
        <div className="flex items-center gap-2">{typeBadge(preview)}<span className="text-xs text-ui-muted">{matchedNodes(preview).length} 个匹配节点</span></div>
        {(preview.type === 'direct' || preview.type === 'reject') && <p className="text-xs text-ui-secondary">{preview.type === 'direct' ? 'DIRECT' : 'REJECT'}</p>}
        {!isTerminal(preview) && !!preview.proxies?.length && <Field><Label>出站</Label><div className="flex flex-wrap items-center gap-1.5">{preview.proxies.map((value, index) => <span key={index} className="inline-flex items-center gap-1.5 max-w-full">{preview.type === 'relay' && index > 0 && <ChevronRight size={12} className="shrink-0 text-ui-muted" />}<Badge className="max-w-full"><span className="truncate" title={outbound(value).label}>{outbound(value).label}{!outbound(value).available && ' · 不可用'}</span></Badge></span>)}</div></Field>}
        {!isTerminal(preview) && sourceNames(preview).length > 0 && <Field><Label>上游订阅</Label><p className="text-xs text-ui-secondary break-all">{sourceNames(preview).join('、')}</p></Field>}
        {!isTerminal(preview) && <Field><Label>匹配节点</Label><div className="rounded-xl border border-ui-border divide-y divide-ui-divider max-h-80 overflow-auto">{matchedNodes(preview).map(node => <div key={node.id} className="flex items-center justify-between gap-3 p-3 text-xs">
          <div className="min-w-0"><p className="font-medium truncate" title={node.name}>{node.countryEmoji} {node.name}</p><p className="text-[10px] text-ui-muted mt-1">{sources.find(source => source.id === node.sourceId)?.name || node.sourceName}</p><p className="text-[10px] text-ui-muted font-mono truncate mt-1">{node.server}:{node.port}</p></div><Badge className="font-mono shrink-0">{node.type.toUpperCase()}</Badge>
        </div>)}{!matchedNodes(preview).length && <p className="p-6 text-center text-xs text-ui-muted">暂无匹配节点</p>}</div></Field>}
      </ModalBody><ModalFooter><button className="ui-button-secondary" onClick={() => { setPreviewId(null); openEditor(preview); }}>编辑策略组</button><button className="ui-button-secondary" onClick={() => setPreviewId(null)}>关闭</button></ModalFooter></>}
    </Modal>

    <Modal open={yamlOpen} title="YAML 编辑" size="wide" layout="editor" onClose={closeYaml}>
      <ModalBody editor>{yamlError && <p role="alert" className="text-xs text-ui-danger max-h-32 overflow-auto whitespace-pre-wrap">{yamlError}</p>}<Textarea variant="code" aria-label="策略组 YAML" aria-invalid={!!yamlError} value={yamlText} onChange={event => setYamlText(event.target.value)} spellCheck={false} className="w-full font-mono resize-none" /></ModalBody>
      <ModalFooter><button className="ui-button-secondary" disabled={yamlSaving} onClick={closeYaml}>取消</button><button disabled={yamlSaving} className="ui-button-primary" onClick={saveYaml}>{yamlSaving ? '保存中...' : '替换全部策略组'}</button></ModalFooter>
    </Modal>
  </div>;
}
