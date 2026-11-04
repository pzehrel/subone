import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Select, SelectItem } from './ui/Select';
import { Field, Label } from './ui/Field';
import { Badge } from './ui/Badge';
import { Popconfirm } from './ui/Popconfirm';
import { SourcesIcon } from './ui/module-icons';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState, useMemo } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Edit2,
  Eraser,
  ExternalLink,
  FileText,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react';
import { SubscriptionSource, ProxyNode, ConfigTemplate } from '../types';
import { nodeToUri } from '../utils/nodeUri';
import { copyToClipboard } from '../utils/clipboard';
import { formatSubscriptionTraffic, formatSubscriptionExpiry } from '../utils/subscriptionInfo';
import { HelpTooltip } from './HelpTooltip';

function previewInfoMatches(source: SubscriptionSource | null, pattern: string) {
  if (!pattern.trim()) return { names: [], error: '' };
  try {
    const regex = new RegExp(pattern.trim(), 'i');
    const names = [...(source?.nodes || []), ...(source?.infoNodes || [])]
      .filter(node => regex.test(node.name)).map(node => node.name);
    return { names, error: '' };
  } catch {
    return { names: [], error: '正则无效，请检查表达式' };
  }
}

interface SourcesManagerProps {
  sources: SubscriptionSource[];
  nodes?: ProxyNode[];
  templates?: ConfigTemplate[];
  onAddSource: (source: { name: string; url?: string; type: string; filterConfig?: any; trafficNodeRegex?: string; expiryNodeRegex?: string }) => Promise<void>;
  onAddCustomGroup?: (name: string) => Promise<void>;
  onUpdateSource: (id: string, updates: Partial<SubscriptionSource>) => Promise<void>;
  onDeleteSource: (id: string) => Promise<void>;
  onRefreshSource: (id: string) => Promise<void>;
  onRefreshAllSources?: () => Promise<void>;
  onImportCustomNodes: (text: string, replaceAll?: boolean, targetSourceId?: string) => Promise<void>;
  onUpdateCustomNode?: (id: string, updates: Partial<ProxyNode>) => Promise<void>;
  onDeleteCustomNode: (id: string) => Promise<void>;
}

export const SourcesManager: React.FC<SourcesManagerProps> = ({
  sources,
  nodes,
  templates = [],
  onAddSource,
  onAddCustomGroup,
  onUpdateSource,
  onDeleteSource,
  onRefreshSource,
  onRefreshAllSources,
  onImportCustomNodes,
  onUpdateCustomNode,
  onDeleteCustomNode,
}) => {
  // Modal states
  const [showAddNetworkModal, setShowAddNetworkModal] = useState(false);
  const [editingNetworkSource, setEditingNetworkSource] = useState<SubscriptionSource | null>(null);
  const [showImportNodesModal, setShowImportNodesModal] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [renamingSource, setRenamingSource] = useState<SubscriptionSource | null>(null);
  const [newGroupNameInput, setNewGroupNameInput] = useState('');

  // Extract custom template outbounds and existing node detours for detour selection
  const availableDetourOutbounds = useMemo(() => {
    const customTags: string[] = [];
    (templates || []).forEach(tpl => {
      if (tpl.content) {
        try {
          const parsed = JSON.parse(tpl.content);
          if (Array.isArray(parsed.outbounds)) {
            parsed.outbounds.forEach((o: any) => {
              const tag = (o?.tag || '').trim();
              if (tag && tag !== 'REJECT' && tag !== 'GLOBAL' && !customTags.includes(tag)) {
                customTags.push(tag);
              }
            });
          }
        } catch { }
      }
    });
    (nodes || []).forEach(n => {
      const tag = (n.detour || '').trim();
      if (tag && !customTags.includes(tag)) {
        customTags.push(tag);
      }
    });
    return customTags;
  }, [templates, nodes]);

  // Node edit state (name & config text & detour)
  const [editingNode, setEditingNode] = useState<{ id: string; name: string; rawText: string; detour?: string } | null>(null);
  const [editNodeNameInput, setEditNodeNameInput] = useState('');
  const [editNodeTextInput, setEditNodeTextInput] = useState('');
  const [editNodeDetourInput, setEditNodeDetourInput] = useState('');

  // Target group for importing nodes
  const [targetGroupId, setTargetGroupId] = useState<string>('custom');
  const [customText, setCustomText] = useState('');
  const [customReplaceAll, setCustomReplaceAll] = useState(false);

  // Bulk edit all subscription text for a custom group
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const [bulkEditingSource, setBulkEditingSource] = useState<SubscriptionSource | null>(null);
  const [bulkEditText, setBulkEditText] = useState('');
  const [bulkEditCopied, setBulkEditCopied] = useState(false);

  // Network source form states
  const [newNetworkName, setNewNetworkName] = useState('');
  const [newNetworkUrl, setNewNetworkUrl] = useState('');
  const [newNetworkType, setNewNetworkType] = useState<NonNullable<SubscriptionSource['type']>>('auto');
  const [trafficNodeRegex, setTrafficNodeRegex] = useState('');
  const [expiryNodeRegex, setExpiryNodeRegex] = useState('');
  const trafficMatches = useMemo(() => previewInfoMatches(editingNetworkSource, trafficNodeRegex), [editingNetworkSource, trafficNodeRegex]);
  const expiryMatches = useMemo(() => previewInfoMatches(editingNetworkSource, expiryNodeRegex), [editingNetworkSource, expiryNodeRegex]);

  // Loading & Action states
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmBulkClear, setConfirmBulkClear] = useState(false);
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);

  // Accordion expanded source IDs (默认全部收起)
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(new Set());



  const isSourceManual = (s: SubscriptionSource) => {
    if (s.type === 'manual' || s.type === 'custom' || s.id === 'custom') return true;
    if (!s.url || typeof s.url !== 'string' || !s.url.trim()) return true;
    const trimmed = s.url.trim().toLowerCase();
    return !trimmed.startsWith('http://') && !trimmed.startsWith('https://');
  };

  // Partition sources: Manual Node Groups vs Remote Subscriptions
  const customSources = useMemo(() => {
    return sources.filter(isSourceManual).sort((a, b) => a.name.localeCompare(b.name));
  }, [sources]);

  const networkSources = useMemo(() => {
    return sources.filter(s => !isSourceManual(s)).sort((a, b) => a.name.localeCompare(b.name));
  }, [sources]);

  // Unified list: Manual groups first, then Network Subscriptions
  const unifiedSources = useMemo(() => {
    return [...customSources, ...networkSources];
  }, [customSources, networkSources]);

  // Total nodes count
  const totalNodesCount = useMemo(() => {
    return sources.reduce((acc, s) => acc + (s.nodes?.length || s.nodeCount || 0), 0);
  }, [sources]);

  // Toggle accordion expand
  const toggleExpand = (sourceId: string) => {
    setExpandedSourceIds(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) {
        next.delete(sourceId);
      } else {
        next.add(sourceId);
      }
      return next;
    });
  };

  // Open import modal targeting a specific group
  const handleOpenImportModal = (groupId?: string) => {
    const defaultGroup = groupId || customSources[0]?.id || 'custom';
    setTargetGroupId(defaultGroup);
    setCustomText('');
    setCustomReplaceAll(false);
    setShowImportNodesModal(true);
  };

  // Open bulk edit modal for subscription text
  const handleOpenBulkEditModal = (source: SubscriptionSource) => {
    setConfirmBulkClear(false);
    setBulkEditingSource(source);
    const nodes = source.nodes || [];
    const text = nodes
      .map(node => (typeof node.raw === 'string' && node.raw.trim()) ? node.raw.trim() : nodeToUri(node))
      .filter(Boolean)
      .join('\n');
    setBulkEditText(text);
    setBulkEditCopied(false);
    setShowBulkEditModal(true);
  };

  const handleBulkEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkEditingSource || isSubmitting) return;
    if (!bulkEditText.trim()) {
      setConfirmBulkClear(true);
      return;
    }
    try {
      await saveBulkEdit();
    } catch (err: any) {
      console.error('Failed to bulk edit subscription text:', err);
      alert(err.message || '更新失败，请检查节点文本格式');
    }
  };

  const saveBulkEdit = async () => {
    if (!bulkEditingSource || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onImportCustomNodes(bulkEditText, true, bulkEditingSource.id);
      setShowBulkEditModal(false);
      setBulkEditingSource(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyBulkEditText = async () => {
    if (!bulkEditText) return;
    const ok = await copyToClipboard(bulkEditText);
    if (ok) {
      setBulkEditCopied(true);
      setTimeout(() => setBulkEditCopied(false), 2000);
    }
  };

  const handleOpenAddNetworkModal = () => {
    setEditingNetworkSource(null);
    setNewNetworkName('');
    setNewNetworkUrl('');
    setNewNetworkType('auto');
    setTrafficNodeRegex('');
    setExpiryNodeRegex('');
    setShowAddNetworkModal(true);
  };

  // Open edit modal for network source
  const handleOpenEditNetworkModal = (source: SubscriptionSource) => {
    setEditingNetworkSource(source);
    setNewNetworkName(source.name);
    setNewNetworkUrl(source.url || '');
    setNewNetworkType(source.type || 'auto');
    setTrafficNodeRegex(source.trafficNodeRegex || '');
    setExpiryNodeRegex(source.expiryNodeRegex || '');
    setShowAddNetworkModal(true);
  };

  // Submit network source (create or edit)
  const handleAddNetworkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNetworkName.trim() || !newNetworkUrl.trim()) return;
    if (trafficMatches.error || expiryMatches.error) return;
    setIsSubmitting(true);
    try {
      if (editingNetworkSource) {
        await onUpdateSource(editingNetworkSource.id, {
          name: newNetworkName.trim(),
          url: newNetworkUrl.trim(),
          type: newNetworkType,
          trafficNodeRegex: trafficNodeRegex.trim(),
          expiryNodeRegex: expiryNodeRegex.trim(),
        });
      } else {
        await onAddSource({
          name: newNetworkName.trim(),
          url: newNetworkUrl.trim(),
          type: newNetworkType,
          trafficNodeRegex: trafficNodeRegex.trim(),
          expiryNodeRegex: expiryNodeRegex.trim(),
        });
      }
      setShowAddNetworkModal(false);
    } catch (err: any) {
      console.error('Failed to save network source:', err);
      alert(err.message || '保存订阅失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit new custom group
  const handleCreateGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newGroupNameInput.trim();
    if (!name) return;
    setIsSubmitting(true);
    try {
      if (onAddCustomGroup) {
        await onAddCustomGroup(name);
      } else {
        await onAddSource({ name, url: '', type: 'custom' });
      }
      setNewGroupNameInput('');
      setShowCreateGroupModal(false);
    } catch (err: any) {
      alert(err.message || '创建节点组失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit rename source
  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingSource || !newGroupNameInput.trim()) return;
    setIsSubmitting(true);
    try {
      await onUpdateSource(renamingSource.id, { name: newGroupNameInput.trim() });
      setRenamingSource(null);
      setNewGroupNameInput('');
    } catch (err: any) {
      alert(err.message || '重命名失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit edit node (name and configuration text)
  const handleEditNodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingNode || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (onUpdateCustomNode) {
        await onUpdateCustomNode(editingNode.id, {
          name: editNodeNameInput.trim(),
          text: editNodeTextInput.trim(),
          raw: editNodeTextInput.trim(),
          detour: editNodeDetourInput.trim(),
        } as any);
      }
      setEditingNode(null);
      setEditNodeNameInput('');
      setEditNodeTextInput('');
      setEditNodeDetourInput('');
    } catch (err: any) {
      alert(err.message || '修改节点配置失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit import nodes
  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onImportCustomNodes(customText, customReplaceAll, targetGroupId);
      setCustomText('');
      setShowImportNodesModal(false);
      // Auto-expand the target group
      setExpandedSourceIds(prev => new Set([...prev, targetGroupId]));
    } catch (err: any) {
      alert(err.message || '导入节点失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Single refresh
  const handleSingleRefresh = async (id: string) => {
    setRefreshingId(id);
    try {
      await onRefreshSource(id);
    } finally {
      setRefreshingId(null);
    }
  };

  // Copy node URI or info (robust with fallback for HTTP / non-secure contexts)
  const handleCopyNode = async (node: ProxyNode) => {
    try {
      const textToCopy = (typeof node.raw === 'string' && node.raw.trim()) ? node.raw.trim() : nodeToUri(node);
      const ok = await copyToClipboard(textToCopy);
      if (ok) {
        setCopiedNodeId(node.id);
        setTimeout(() => setCopiedNodeId(null), 1500);
      } else {
        window.prompt('请手动复制节点链接：', textToCopy);
      }
    } catch (err) {
      console.error('handleCopyNode error:', err);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-16">
      {/* 1. 顶部操作栏卡片 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 bg-ui-surface p-4 rounded-2xl border border-ui-border shadow-2xs">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SourcesIcon className="w-5 h-5 text-ui-accent" aria-hidden="true" />
            <h1 className="text-base font-bold text-ui-text">上游订阅</h1>
            <Badge tone="accent" className="font-mono border">
              共 {totalNodesCount} 节点
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-ui-secondary">
            管理网络订阅与独立节点，为订阅配置提供节点来源。
          </p>
        </div>

        {/* 顶部操作按钮组 */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            onClick={handleOpenAddNetworkModal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold ui-button-primary rounded-xl shadow-2xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>添加订阅</span>
          </button>

          <button
            onClick={() => handleOpenImportModal()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold ui-button-secondary rounded-xl shadow-2xs cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>导入节点</span>
          </button>
        </div>
      </div>

      {/* 2. 统一卡片流（自建组自然置顶，网络订阅紧随其后） */}
      <div className="space-y-3">
        {unifiedSources.map(source => {
          const isCustom = isSourceManual(source);
          const isExpanded = expandedSourceIds.has(source.id);
          const isThisRefreshing = refreshingId === source.id;
          const nodesList = source.nodes || [];
          const traffic = !isCustom && formatSubscriptionTraffic(source.subscriptionInfo);
          const expiry = !isCustom && formatSubscriptionExpiry(source.subscriptionInfo);

          return (
            <div
              key={source.id}
              className={`rounded-2xl border transition-all duration-200 bg-ui-surface overflow-hidden shadow-2xs ${source.enabled !== false
                ? isExpanded
                  ? 'border-ui-accent/60 shadow-sm'
                  : 'border-ui-border hover:border-ui-accent/40'
                : 'border-ui-border opacity-65 bg-ui-subtle'
                }`}
            >
              {/* 卡片主横条 (Header) */}
              <div
                className={`p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer select-none transition-colors ${isExpanded ? 'bg-[#FCFAF7]' : 'hover:bg-[#FCFBF9]'
                  }`}
                onClick={() => toggleExpand(source.id)}
              >
                {/* 左侧：名称、节点数、副标题 */}
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  {/* 折叠展开箭头指示器 */}
                  <div className="mt-0.5 shrink-0 text-ui-muted hover:text-ui-text transition-transform duration-200">
                    <ChevronDown
                      className={`w-4 h-4 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-ui-accent' : ''
                        }`}
                    />
                  </div>

                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* 标题 */}
                      <h3 className={`text-xs font-bold truncate max-w-xs sm:max-w-md ${source.enabled === false ? 'text-ui-muted' : 'text-ui-text'}`}>
                        {source.name}
                      </h3>

                      {/* 节点数徽章 */}
                      <Badge className="font-mono">
                        {nodesList.length} 节点
                      </Badge>

                      {/* 停用状态提示徽章 */}
                      {source.enabled === false && (
                        <Badge tone="neutral" className="border">
                          已停用 (不导出)
                        </Badge>
                      )}
                    </div>

                    {/* 卡片副信息 */}
                    {/* 更新时间提示 */}
                    {(traffic || expiry) && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ui-secondary">
                        {traffic && <span>{traffic}</span>}
                        {expiry && <span>{expiry}</span>}
                      </div>
                    )}
                    {source.lastUpdated && (
                      <div className="text-[10px] text-ui-muted">
                        最后同步: {new Date(source.lastUpdated).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>

                {/* 右侧快捷操作按钮 */}
                <div
                  className="flex items-center gap-1 self-end sm:self-center shrink-0"
                  onClick={e => e.stopPropagation()}
                >
                  {/* 自建独立组操作 */}
                  {isCustom && (
                    <>
                      <button
                        onClick={() => handleOpenBulkEditModal(source)}
                        className="p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer"
                        title="批量编辑节点文本"
                      >
                        <FileText className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleOpenImportModal(source.id)}
                        className="p-1.5 text-ui-accent hover:text-[#B85D3F] hover:bg-ui-accent-soft rounded-lg transition-colors cursor-pointer"
                        title="导入节点到此组"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>

                      {nodesList.length > 0 && (
                        <Popconfirm
                          title="清空全部节点？"
                          description={`将清空「${source.name}」中的 ${nodesList.length} 个节点，节点组仍会保留。`}
                          confirmText="清空"
                          danger
                          onConfirm={() => onImportCustomNodes('', true, source.id)}
                        >
                          <button
                            className="ui-icon-button-danger p-1.5 rounded-lg"
                            title="清空此组所有节点"
                          >
                            <Eraser className="w-3.5 h-3.5" />
                          </button>
                        </Popconfirm>
                      )}

                      <button
                        onClick={() => {
                          setRenamingSource(source);
                          setNewGroupNameInput(source.name);
                        }}
                        className="p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer"
                        title="重命名节点组"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>


                      <Popconfirm
                        title="删除节点组？"
                        description={`将删除「${source.name}」及组内全部节点，此操作无法撤销。`}
                        confirmText="删除"
                        danger
                        onConfirm={() => onDeleteSource(source.id)}
                      >
                        <button
                          className="ui-icon-button-danger p-1.5 rounded-lg"
                          title="删除节点组"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Popconfirm>
                    </>
                  )}

                  {/* 网络订阅专属操作 */}
                  {!isCustom && (
                    <>
                      <button
                        onClick={() => handleOpenEditNetworkModal(source)}
                        className="p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover rounded-lg transition-colors cursor-pointer"
                        title="编辑订阅源"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleSingleRefresh(source.id)}
                        disabled={isThisRefreshing}
                        className="p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                        title="刷新订阅"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 text-ui-accent ${isThisRefreshing ? 'animate-spin' : ''}`} />
                      </button>

                      <button
                        onClick={() => onUpdateSource(source.id, { enabled: !source.enabled })}
                        className="p-1.5 text-ui-muted hover:text-ui-text hover:bg-ui-hover/60 rounded-lg transition-colors cursor-pointer"
                        title={source.enabled !== false ? '点击停用' : '点击启用'}
                      >
                        {source.enabled !== false ? (
                          <CheckCircle2 className="w-4 h-4 text-[#367A68]" />
                        ) : (
                          <XCircle className="w-4 h-4 text-ui-muted" />
                        )}
                      </button>

                      <Popconfirm
                        title="删除上游订阅？"
                        description={`将删除「${source.name}」及其节点，此操作无法撤销。`}
                        confirmText="删除"
                        danger
                        onConfirm={() => onDeleteSource(source.id)}
                      >
                        <button
                          className="ui-icon-button-danger p-1.5 rounded-lg"
                          title="删除订阅源"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </Popconfirm>
                    </>
                  )}
                </div>
              </div>

              {/* 3. 展开区域：就地查看节点详情 (Accordion) */}
              {isExpanded && (
                <div className="border-t border-ui-divider bg-ui-surface animate-in fade-in duration-150">
                  {/* 节点列表渲染 */}
                  {nodesList.length > 0 ? (
                    <div className="divide-y divide-ui-divider">
                      {nodesList.map(node => (
                        <div
                          key={node.id}
                          className="px-4 py-2 hover:bg-ui-subtle transition-colors flex items-center justify-between gap-3 text-xs group/item"
                        >
                          {/* 左侧：Emoji、节点名、协议类型、服务器端口 */}
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <span className="text-sm shrink-0">{node.countryEmoji || '🌐'}</span>
                            <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                              <span className="font-bold text-ui-text truncate max-w-md">
                                {node.name}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Badge tone="neutral" className="font-mono">
                                  {(node.type || 'vless').toUpperCase()}
                                </Badge>
                                {node.detour && (
                                  <Badge tone="accent" className="border font-medium">
                                    {node.detour}
                                  </Badge>
                                )}
                                <span className="text-[11px] font-mono text-ui-muted truncate">
                                  {node.server}:{node.port}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* 右侧微操作：复制链接、改名、删除自建节点 */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => handleCopyNode(node)}
                              className="p-1 text-ui-muted hover:text-ui-text hover:bg-ui-hover rounded transition-colors cursor-pointer"
                              title="复制节点链接"
                            >
                              {copiedNodeId === node.id ? (
                                <Check className="w-3.5 h-3.5 text-[#367A68]" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>

                            <button
                              onClick={() => {
                                const uriText = (typeof node.raw === 'string' && node.raw.trim()) ? node.raw.trim() : nodeToUri(node);
                                setEditingNode({ id: node.id, name: node.name, rawText: uriText, detour: node.detour });
                                setEditNodeNameInput(node.name);
                                setEditNodeTextInput(uriText);
                                setEditNodeDetourInput(node.detour || '');
                              }}
                              className="p-1 text-ui-muted hover:text-ui-text hover:bg-ui-hover rounded transition-colors cursor-pointer"
                              title="修改节点与配置文本"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>

                            {isCustom && (
                              <Popconfirm
                                title="删除节点？"
                                description={`将删除「${node.name}」，此操作无法撤销。`}
                                confirmText="删除"
                                danger
                                onConfirm={() => onDeleteCustomNode(node.id)}
                              >
                                <button
                                  className="ui-icon-button-danger p-1 rounded"
                                  title="删除此节点"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </Popconfirm>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-6 text-center space-y-2">
                      <p className="text-xs font-medium text-ui-muted">
                        该组暂无节点
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {unifiedSources.length === 0 && (
          <div className="p-12 rounded-2xl bg-ui-surface border border-dashed border-ui-border text-center space-y-3">
            <SourcesIcon className="w-8 h-8 text-ui-muted mx-auto opacity-50" aria-hidden="true" />
            <p className="text-xs font-medium text-ui-secondary">暂无任何订阅或独立节点组</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => handleOpenImportModal()}
                className="px-3 py-1.5 text-xs font-semibold ui-button-primary rounded-xl"
              >
                贴入独立节点
              </button>
              <button
                onClick={handleOpenAddNetworkModal}
                className="px-3 py-1.5 text-xs font-semibold ui-button-secondary rounded-xl"
              >
                添加网络订阅链接
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 弹窗 1：添加/编辑网络机场订阅弹窗 */}
      <Modal
        open={showAddNetworkModal}
        title={editingNetworkSource ? '编辑网络订阅源' : '添加网络订阅源'}
        onClose={() => setShowAddNetworkModal(false)}
      >
        <ModalForm onSubmit={handleAddNetworkSubmit}>
          <ModalBody>
            <Field>
              <Label className="block">订阅源名称</Label>
              <Input
                type="text"
                required
                placeholder=""
                value={newNetworkName}
                onChange={e => setNewNetworkName(e.target.value)}
                className="w-full"
              />
            </Field>

            <Field>
              <Label className="block">订阅 URL</Label>
              <Textarea variant="default"
                rows={3}
                required
                placeholder="https://airport.com/api/v1/client/subscribe?token=..."
                value={newNetworkUrl}
                onChange={e => {
                  const input = document.createElement('input');
                  input.type = 'url';
                  input.value = e.target.value.trim();
                  e.target.setCustomValidity(input.validity.typeMismatch ? '请输入有效的订阅 URL' : '');
                  setNewNetworkUrl(e.target.value);
                }}
                className="w-full font-mono resize-y"
              />
            </Field>

            <Field>
              <Label className="block">格式解析模式</Label>
              <Select
                value={newNetworkType}
                onValueChange={nextValue => setNewNetworkType(nextValue as NonNullable<SubscriptionSource['type']>)}
                className="w-full"
              >
                <SelectItem value="auto">自动识别 (Auto)</SelectItem>
                <SelectItem value="clash">Clash YAML</SelectItem>
                <SelectItem value="singbox">Singbox JSON</SelectItem>
                <SelectItem value="quantumultx">QuanX (Quantumult X)</SelectItem>
                <SelectItem value="base64">Base64 编码节点串</SelectItem>
              </Select>
            </Field>

            <div className="space-y-3">
              {[
                { id: 'traffic-node-regex', label: '流量信息匹配', help: '按节点名称匹配流量信息，例如“剩余流量|已用流量”。匹配项显示为订阅信息，不计入可用节点。留空则不匹配。', value: trafficNodeRegex, setValue: setTrafficNodeRegex, placeholder: '剩余流量|已用流量|流量用量', preview: trafficMatches },
                { id: 'expiry-node-regex', label: '到期信息匹配', help: '按节点名称匹配到期信息，例如“套餐到期|有效期”。匹配项显示为订阅信息，不计入可用节点。留空则不匹配。', value: expiryNodeRegex, setValue: setExpiryNodeRegex, placeholder: '套餐到期|到期时间|有效期', preview: expiryMatches },
              ].map(field => (
                <Field id={field.id} key={field.id}>
                  <div className="mb-1 flex items-center gap-1">
                    <Label htmlFor={field.id}>{field.label}</Label>
                    <HelpTooltip label={`${field.label}说明`} content={field.help} />
                  </div>
                  <Input
                    id={field.id}
                    type="text"
                    value={field.value}
                    onChange={e => field.setValue(e.target.value)}
                    placeholder={field.placeholder}
                    aria-invalid={!!field.preview.error}
                    aria-describedby={`${field.id}-preview`}
                    className="w-full font-mono"
                  />
                  <div id={`${field.id}-preview`} className={`mt-1 text-[11px] ${field.preview.error ? 'text-red-600' : 'text-ui-secondary'}`}>
                    {field.preview.error || (field.value.trim() && (editingNetworkSource ? `匹配 ${field.preview.names.length} 项` : '添加并拉取后匹配'))}
                    {field.preview.names.length > 0 && (
                      <ul className="mt-1 max-h-20 overflow-y-auto space-y-1 break-words">
                        {field.preview.names.map((name, index) => <li key={index}>{name}</li>)}
                      </ul>
                    )}
                  </div>
                </Field>
              ))}
            </div>

          </ModalBody>

          <ModalFooter>
            <button
              type="button"
              onClick={() => setShowAddNetworkModal(false)}
              className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !!trafficMatches.error || !!expiryMatches.error}
              className="px-4 py-1.5 text-xs font-semibold ui-button-primary rounded-xl disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? '保存中...' : (editingNetworkSource ? '保存更改' : '添加并拉取')}
            </button>
          </ModalFooter>
        </ModalForm>
      </Modal>

      {/* 弹窗：编辑所有订阅文本 */}
      <Modal
        open={!!(showBulkEditModal && bulkEditingSource)}
        title="批量编辑节点文本"
        description={(showBulkEditModal && bulkEditingSource) ? <>{bulkEditingSource.name} · 直接查看或批量修改此组包含的所有节点链接，保存将自动重新解析并覆盖更新。</> : undefined}
        size="xl"
        onClose={() => {
          setShowBulkEditModal(false);
          setBulkEditingSource(null);
        }}
      >
        {(showBulkEditModal && bulkEditingSource) && (
          <ModalForm onSubmit={handleBulkEditSubmit}>
            <ModalBody>
              {/* 工具栏：统计与快捷操作 */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-ui-secondary">
                  <span className="font-medium text-ui-text">
                    共 {bulkEditText ? bulkEditText.split('\n').filter(l => l.trim().length > 0).length : 0} 行
                  </span>
                  <span>·</span>
                  <span>原包含 {bulkEditingSource.nodes?.length || 0} 个节点</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyBulkEditText}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-ui-secondary hover:text-ui-text bg-ui-subtle hover:bg-ui-divider border border-ui-border rounded-lg transition-colors cursor-pointer"
                    title="复制所有文本到剪贴板"
                  >
                    {bulkEditCopied ? (
                      <>
                        <Check className="w-3 h-3 text-[#367A68]" />
                        <span className="text-[#367A68]">已复制</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>复制全部</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setBulkEditText('')}
                    className="px-2.5 py-1 text-[11px] font-medium text-ui-muted hover:text-[#B85D3F] hover:bg-ui-accent-soft rounded-lg transition-colors cursor-pointer"
                    title="清空文本框"
                  >
                    清空
                  </button>
                </div>
              </div>

              {/* 文本编辑区域 */}
              <div>
                <Textarea variant="code"
                  rows={13}
                  value={bulkEditText}
                  onChange={e => setBulkEditText(e.target.value)}
                  placeholder={`支持每行一个节点链接：\nvless://...\nhysteria2://...\nss://...\ntrojan://...\n或 Clash YAML / Singbox JSON / QuanX 节点`}
                  className="w-full font-mono resize-y break-all"
                />
              </div>
            </ModalBody>
            <ModalFooter className="justify-between">
              <p className="text-[11px] text-ui-muted">
                💡 提示：保存后将使用此文本完全覆盖更新该组的节点
              </p>

              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setShowBulkEditModal(false);
                    setBulkEditingSource(null);
                  }}
                  className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl cursor-pointer"
                >
                  取消
                </button>
                {!bulkEditText.trim() ? (
                  <Popconfirm
                    title="清空全部节点？"
                    description={`文本内容为空，保存后将清空「${bulkEditingSource?.name}」中的所有节点。`}
                    confirmText="清空并保存"
                    danger
                    open={confirmBulkClear}
                    onOpenChange={setConfirmBulkClear}
                    onConfirm={saveBulkEdit}
                  >
                    <button type="button" disabled={isSubmitting} className="ui-button-primary">
                      {isSubmitting ? '保存更新中...' : '保存修改'}
                    </button>
                  </Popconfirm>
                ) : (
                  <button type="submit" disabled={isSubmitting} className="ui-button-primary">
                    {isSubmitting ? '保存更新中...' : '保存修改'}
                  </button>
                )}
              </div>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* 弹窗 2：批量贴入 / 添加自建独立节点弹窗 */}
      <Modal
        open={!!(showImportNodesModal)}
        title="批量贴入独立节点"
        size="lg"
        onClose={() => setShowImportNodesModal(false)}
      >
        {(showImportNodesModal) && (
          <ModalForm onSubmit={handleImportSubmit}>
            <ModalBody>
              {/* 目标节点组选择 */}
              <Field>
                <div className="flex items-center justify-between mb-1">
                  <Label>存入独立节点组</Label>
                  <button
                    type="button"
                    onClick={() => {
                      setNewGroupNameInput('');
                      setShowCreateGroupModal(true);
                    }}
                    className="text-[11px] text-ui-accent hover:underline font-medium"
                  >
                    + 新建独立节点组
                  </button>
                </div>
                <Select
                  value={targetGroupId}
                  onValueChange={nextValue => setTargetGroupId(nextValue)}
                  className="w-full"
                >
                  {customSources.map(cs => (
                    <SelectItem key={cs.id} value={cs.id}>
                      {cs.name} ({cs.nodes?.length || 0} 个节点)
                    </SelectItem>
                  ))}
                </Select>
              </Field>

              {/* 链接文本输入域 */}
              <Field>
                <Label className="block">节点链接 / 片段</Label>
                <Textarea variant="code"
                  required
                  rows={9}
                  value={customText}
                  onChange={e => setCustomText(e.target.value)}
                  className="w-full font-mono"
                />
              </Field>
            </ModalBody>
            <ModalFooter>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportNodesModal(false)}
                  className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-1.5 text-xs font-semibold ui-button-primary rounded-xl disabled:opacity-50"
                >
                  {isSubmitting ? '解析导入中...' : '解析并存入'}
                </button>
              </div>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* 弹窗 3：新建自建组弹窗 */}
      <Modal
        open={!!(showCreateGroupModal)}
        title="新建独立节点组"
        size="sm"
        onClose={() => setShowCreateGroupModal(false)}
      >
        {(showCreateGroupModal) && (
          <ModalForm onSubmit={handleCreateGroupSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">节点组名称</Label>
                <Input
                  type="text"
                  required
                  autoFocus
                  placeholder=""
                  value={newGroupNameInput}
                  onChange={e => setNewGroupNameInput(e.target.value)}
                  className="w-full"
                />
              </Field>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowCreateGroupModal(false)}
                className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-1.5 text-xs font-semibold ui-button-primary rounded-xl disabled:opacity-50"
              >
                {isSubmitting ? '创建中...' : '立即创建'}
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* 弹窗 4：重命名节点组弹窗 */}
      <Modal
        open={!!(renamingSource)}
        title="重命名节点组"
        size="sm"
        onClose={() => setRenamingSource(null)}
      >
        {(renamingSource) && (
          <ModalForm onSubmit={handleRenameSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">新组名</Label>
                <Input
                  type="text"
                  required
                  autoFocus
                  value={newGroupNameInput}
                  onChange={e => setNewGroupNameInput(e.target.value)}
                  className="w-full"
                />
              </Field>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setRenamingSource(null)}
                className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-1.5 text-xs font-semibold ui-button-primary rounded-xl disabled:opacity-50"
              >
                {isSubmitting ? '保存中...' : '保存'}
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>
      {/* 编辑节点与配置文本弹窗 */}
      <Modal
        open={!!(editingNode)}
        title="编辑节点配置"
        size="lg"
        onClose={() => {
          setEditingNode(null);
          setEditNodeDetourInput('');
        }}
      >
        {(editingNode) && (
          <ModalForm onSubmit={handleEditNodeSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">
                  节点名称
                </Label>
                <Input
                  type="text"
                  required
                  value={editNodeNameInput}
                  onChange={e => setEditNodeNameInput(e.target.value)}
                  placeholder="节点备注名称"
                  className="w-full"
                />
              </Field>

              <Field>
                <div className="flex items-center justify-between mb-1">
                  <Label className="block">
                    配置内容文本
                  </Label>
                  <span className="text-[10px] text-ui-muted">支持修改 URI 链接 / 参数</span>
                </div>
                <Textarea variant="code"
                  rows={5}
                  value={editNodeTextInput}
                  onChange={e => setEditNodeTextInput(e.target.value)}
                  placeholder="vless://... 或 hysteria2://... 或 ss://... 等节点链接"
                  className="w-full font-mono resize-y break-all"
                />
              </Field>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="block">
                    底层出口 (Detour)
                  </Label>
                  <span className="text-[10px] text-ui-muted">指定握手建立隧道的物理宽带出口</span>
                </div>
                {availableDetourOutbounds.length > 0 ? (
                  <Select
                    value={editNodeDetourInput}
                    onValueChange={nextValue => setEditNodeDetourInput(nextValue)}
                    className="w-full"
                  >
                    <SelectItem value="">默认 (系统默认出口)</SelectItem>
                    {availableDetourOutbounds.map(tag => (
                      <SelectItem key={tag} value={tag}>
                        {tag}
                      </SelectItem>
                    ))}
                    {editNodeDetourInput && !availableDetourOutbounds.includes(editNodeDetourInput) && (
                      <SelectItem value={editNodeDetourInput}>{editNodeDetourInput}</SelectItem>
                    )}
                  </Select>
                ) : (
                  <Input aria-label="默认 (系统默认出口) - 留空即默认，或输入指定出口标签"
                    type="text"
                    value={editNodeDetourInput}
                    onChange={e => setEditNodeDetourInput(e.target.value)}
                    placeholder="默认 (系统默认出口) - 留空即默认，或输入指定出口标签"
                    className="w-full"
                  />
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => {
                  setEditingNode(null);
                  setEditNodeDetourInput('');
                }}
                className="px-3.5 py-1.5 text-xs font-medium ui-button-secondary rounded-xl cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-1.5 text-xs font-semibold ui-button-primary rounded-xl disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? '保存中...' : '保存更改'}
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>


    </div>
  );
};
