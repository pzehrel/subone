import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState, useMemo } from 'react';
import {
  Check,
  Edit2,
  FileCode,
  FileText,
  Filter,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { ProxyGroupItem, UnifiedRuleItem, ConfigTemplate } from '../types';

interface RulesManagerProps {
  proxyGroups: ProxyGroupItem[];
  rulesList: UnifiedRuleItem[];
  templates?: ConfigTemplate[];
  onAddRule: (rule: Partial<UnifiedRuleItem>) => Promise<void>;
  onImportLocalRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onImportRemoteRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onBatchReplaceRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onUpdateRule: (id: string, updates: Partial<UnifiedRuleItem>) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onClearAllRules: () => Promise<void>;
  onResetDefaultRules?: () => Promise<void>;
}

export const RulesManager: React.FC<RulesManagerProps> = ({
  proxyGroups,
  rulesList,
  templates = [],
  onAddRule,
  onImportLocalRules,
  onImportRemoteRules,
  onBatchReplaceRules,
  onUpdateRule,
  onDeleteRule,
  onClearAllRules,
  onResetDefaultRules,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'local' | 'remote'>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');

  // Full Text Editor modal
  const [showFullTextModal, setShowFullTextModal] = useState(false);
  const [fullRulesText, setFullRulesText] = useState('');

  // Single Add modal
  const [showAddSingleModal, setShowAddSingleModal] = useState(false);
  const [singleName, setSingleName] = useState('');
  const [singleKind, setSingleKind] = useState<'local' | 'remote'>('local');
  const [singleType, setSingleType] = useState<any>('DOMAIN-SUFFIX');
  const [singlePayload, setSinglePayload] = useState('');
  const [singleOutbound, setSingleOutbound] = useState('REJECT');

  const availableOutbounds = useMemo(() => {
    const templateCustomOutbounds: string[] = [];
    (templates || []).forEach(tpl => {
      if (tpl.content) {
        try {
          const parsed = JSON.parse(tpl.content);
          if (Array.isArray(parsed.outbounds)) {
            parsed.outbounds.forEach((o: any) => {
              const tag = (o?.tag || '').trim();
              if (tag && tag !== 'REJECT' && tag !== 'GLOBAL' && !templateCustomOutbounds.includes(tag)) {
                templateCustomOutbounds.push(tag);
              }
            });
          }
        } catch { }
      }
    });

    const list = ['REJECT', ...proxyGroups.map(g => g.name), ...templateCustomOutbounds];
    rulesList.forEach(r => {
      if (r.outbound && !list.includes(r.outbound)) {
        list.push(r.outbound);
      }
    });
    return Array.from(new Set(list));
  }, [proxyGroups, rulesList, templates]);

  // Format rules to text for Full Text Editor
  const formatRulesToText = (rules: UnifiedRuleItem[]): string => {
    const localRules = rules.filter(r => r.kind === 'local');
    const remoteRules = rules.filter(r => r.kind === 'remote');

    const lines: string[] = [];

    if (localRules.length > 0) {
      lines.push('# ================= 本地分流规则 (Local Rules) =================');
      localRules.forEach(r => {
        const comment = r.name && !r.name.startsWith(r.type) ? `  # ${r.name}` : '';
        if (r.type === 'FINAL') {
          lines.push(`- FINAL,${r.outbound}${comment}`);
        } else {
          const payloads = r.payload.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);
          if (payloads.length > 1) {
            payloads.forEach(p => {
              lines.push(`- ${r.type},${p},${r.outbound},no-resolve${comment}`);
            });
          } else {
            lines.push(`- ${r.type},${r.payload.trim()},${r.outbound},no-resolve${comment}`);
          }
        }
      });
      lines.push('');
    }

    if (remoteRules.length > 0) {
      lines.push('# ================= 远程规则集 (Remote Rule-Sets) =================');
      remoteRules.forEach(r => {
        const comment = r.name && !r.name.startsWith(r.type) ? `  # ${r.name}` : '';
        lines.push(`- RULE-SET,${r.payload},${r.outbound}${comment}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  };

  const openFullTextEditor = () => {
    setFullRulesText(formatRulesToText(rulesList));
    setShowFullTextModal(true);
  };

  const handleFullTextSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = fullRulesText;
    const outbound = proxyGroups[0]?.name || '🎯 本地直连';
    setShowFullTextModal(false);
    await onBatchReplaceRules(text, outbound);
  };

  const handleSingleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singlePayload.trim()) return;

    const formattedPayload = singleKind === 'local'
      ? singlePayload.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean).join(', ')
      : singlePayload.trim();

    if (!formattedPayload) return;

    const defaultPrefix = singleType === 'SRC-IP-CIDR' ? '源IP' : singleType;
    const newRuleData = {
      name: singleName.trim() || `${defaultPrefix}: ${formattedPayload.slice(0, 30)}${formattedPayload.length > 30 ? '...' : ''}`,
      kind: singleKind,
      type: singleKind === 'remote' ? 'RULE-SET' : singleType,
      payload: formattedPayload,
      outbound: singleOutbound,
      enabled: true,
    };

    setSingleName('');
    setSinglePayload('');
    setShowAddSingleModal(false);

    await onAddRule(newRuleData);
  };

  // Edit Single Rule modal
  const [editingRule, setEditingRule] = useState<UnifiedRuleItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editKind, setEditKind] = useState<'local' | 'remote'>('local');
  const [editType, setEditType] = useState<any>('DOMAIN-SUFFIX');
  const [editPayload, setEditPayload] = useState('');
  const [editOutbound, setEditOutbound] = useState('');

  const openEditModal = (rule: UnifiedRuleItem) => {
    setEditingRule(rule);
    setEditName(rule.name);
    setEditKind(rule.kind);
    setEditType(rule.type);
    setEditPayload(rule.payload);
    setEditOutbound(rule.outbound);
  };

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRule || !editPayload.trim()) return;

    const formattedPayload = editKind === 'local'
      ? editPayload.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean).join(', ')
      : editPayload.trim();

    if (!formattedPayload) return;

    const ruleId = editingRule.id;
    const defaultPrefix = editType === 'SRC-IP-CIDR' ? '源IP' : editType;
    const updates = {
      name: editName.trim() || `${defaultPrefix}: ${formattedPayload.slice(0, 30)}`,
      kind: editKind,
      type: editKind === 'remote' ? 'RULE-SET' : editType,
      payload: formattedPayload,
      outbound: editOutbound,
    };

    // Close modal immediately for instant 0ms response
    setEditingRule(null);

    await onUpdateRule(ruleId, updates);
  };

  // Filter rules
  const filteredRules = rulesList.filter(rule => {
    const matchesSearch =
      rule.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.payload.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.outbound.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.type.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (rule.type === 'SRC-IP-CIDR' && (
        'source_ip_cidr'.includes(searchTerm.toLowerCase()) ||
        '源ip'.includes(searchTerm.toLowerCase()) ||
        'src-ip'.includes(searchTerm.toLowerCase())
      ));

    const matchesKind = kindFilter === 'all' || rule.kind === kindFilter;
    const matchesGroup = groupFilter === 'all' || rule.outbound === groupFilter;

    return matchesSearch && matchesKind && matchesGroup;
  });

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-16">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-ui-surface p-4 rounded-2xl border border-ui-border shadow-2xs">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-ui-accent" />
            <h2 className="text-base font-bold text-ui-text">分流规则</h2>
            <span className="px-2.5 py-0.5 bg-ui-accent-soft text-[#B85D3F] rounded-md font-mono text-xs font-bold border border-[#F3DDD3]">
              共 {rulesList.length} 组规则
            </span>
          </div>
          <p className="text-xs text-ui-secondary mt-0.5">
            配置本地域名/IP 规则与远程规则集，指定去向
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {onResetDefaultRules && (
            <button
              onClick={async () => {
                if (window.confirm('确定要恢复为模版默认分流规则吗？\n系统将重新从 templates 模版目录载入预设的分流规则。')) {
                  await onResetDefaultRules();
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-button-secondary rounded-xl text-ui-secondary hover:text-[#B85D3F]"
              title="从 templates 模版目录重新载入默认分流规则"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复默认</span>
            </button>
          )}

          <button
            onClick={openFullTextEditor}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium ui-button-secondary rounded-xl"
            title="以文本格式编辑/粘贴规则"
          >
            <FileCode className="w-3.5 h-3.5 text-ui-accent" />
            <span>YAML 编辑</span>
          </button>

          <button
            onClick={() => setShowAddSingleModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold ui-button-primary rounded-xl shadow-2xs"
          >
            <Plus className="w-4 h-4" />
            <span>添加规则</span>
          </button>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="ui-panel p-3.5 rounded-2xl bg-ui-surface border border-ui-border flex flex-col sm:flex-row items-center justify-between gap-3 shadow-2xs">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-ui-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="搜索规则名称、域名、IP 或策略去向..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 bg-ui-subtle border border-ui-border rounded-xl text-xs text-ui-text placeholder-[#9E9A91] focus:outline-none focus:border-ui-accent"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
          {/* Kind Filter */}
          <select
            value={kindFilter}
            onChange={e => setKindFilter(e.target.value as any)}
            className="px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-xs font-medium text-ui-text focus:outline-none focus:border-ui-accent"
          >
            <option value="all">全部类型 ({rulesList.length})</option>
            <option value="local">本地规则 ({rulesList.filter(r => r.kind === 'local').length})</option>
            <option value="remote">远程规则集 ({rulesList.filter(r => r.kind === 'remote').length})</option>
          </select>

          {/* Group Filter */}
          <select
            value={groupFilter}
            onChange={e => setGroupFilter(e.target.value)}
            className="px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-xs font-medium text-ui-text focus:outline-none focus:border-ui-accent"
          >
            <option value="all">全部目标策略</option>
            {availableOutbounds.map(g => (
              <option key={g} value={g}>
                {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Rules Table */}
      <div className="ui-panel rounded-2xl bg-ui-surface border border-ui-border overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-ui-subtle border-b border-ui-border text-ui-secondary font-semibold text-[11px]">
              <tr>
                <th className="py-2.5 px-4 min-w-[160px] max-w-[240px]">规则名称 / 备注</th>
                <th className="py-2.5 px-4 w-28">类型</th>
                <th className="py-2.5 px-4">匹配内容 / 链接</th>
                <th className="py-2.5 px-4 w-52">去向策略组</th>
                <th className="py-2.5 px-4 w-20 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0ECE4]">
              {filteredRules.map(rule => {
                const payloadItems = rule.payload.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
                return (
                  <tr key={rule.id} className="hover:bg-ui-subtle transition-colors">
                    <td className="py-2.5 px-4 font-semibold text-ui-text max-w-[240px] truncate" title={rule.name}>
                      {rule.name}
                    </td>

                    <td className="py-2.5 px-4">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${rule.kind === 'remote'
                          ? 'bg-[#EAF2EE] text-[#2D6A5A]'
                          : rule.type === 'SRC-IP-CIDR'
                            ? 'bg-[#F0EBF8] text-[#6E42A8]'
                            : 'bg-ui-divider text-ui-secondary'
                          }`}
                      >
                        {rule.type}
                      </span>
                    </td>

                    <td className="py-2.5 px-4 max-w-[360px]" title={rule.payload}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        {payloadItems.length > 1 && (
                          <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-ui-accent-soft text-[#B85D3F] rounded border border-[#F3DDD3]">
                            {payloadItems.length} 项
                          </span>
                        )}
                        <span className="font-mono text-ui-secondary text-[11px] truncate select-all">
                          {rule.payload}
                        </span>
                      </div>
                    </td>

                    <td className="py-2.5 px-4">
                      <select
                        value={rule.outbound}
                        onChange={e => onUpdateRule(rule.id, { outbound: e.target.value })}
                        className={`w-full px-2.5 py-1 bg-ui-surface border rounded-lg text-xs font-semibold focus:outline-none focus:border-ui-accent transition-colors ${rule.outbound === 'REJECT'
                          ? 'border-red-200 text-red-600 bg-red-50/50'
                          : 'border-ui-border text-ui-text hover:border-ui-accent'
                          }`}
                      >
                        {availableOutbounds.map(g => (
                          <option key={g} value={g}>
                            {g === 'REJECT' ? '🛑 REJECT' : g}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEditModal(rule)}
                          className="p-1 text-ui-muted hover:text-ui-accent hover:bg-ui-accent-soft rounded-lg transition-colors"
                          title="编辑规则"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => onDeleteRule(rule.id)}
                          className="p-1 text-ui-muted hover:text-[#B85D3F] hover:bg-ui-accent-soft rounded-lg transition-colors"
                          title="删除规则"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filteredRules.length === 0 && (
          <div className="p-12 text-center text-xs text-ui-secondary">
            <p>未找到符合条件的规则</p>
          </div>
        )}
      </div>

      {/* Full Text Editor Modal */}
      <Modal
        open={!!(showFullTextModal)}
        title={(showFullTextModal) ? <>分流规则文本编辑</> : ''}
        description={(showFullTextModal) ? <>以 Clash / YAML 格式编辑规则，支持 DOMAIN-SUFFIX、IP-CIDR、SRC-IP-CIDR 等，用注释 # 备注与目标去向</> : undefined}
        size="wide"
        layout="editor"
        onClose={() => setShowFullTextModal(false)}
      >
        {(showFullTextModal) && (
          <ModalForm onSubmit={handleFullTextSave}>
            <ModalBody editor>
              <div className="flex-1 min-h-0 w-full relative">
                <textarea
                  value={fullRulesText}
                  onChange={e => setFullRulesText(e.target.value)}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full p-4 bg-ui-subtle border border-ui-border rounded-xl font-mono text-xs text-ui-text focus:outline-none focus:border-ui-accent resize-none leading-relaxed"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowFullTextModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-6 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                保存并同步
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* Add Single Rule Modal */}
      <Modal
        open={!!(showAddSingleModal)}
        title={(showAddSingleModal) ? <>添加单条规则</> : ''}
        size="lg"
        onClose={() => setShowAddSingleModal(false)}
      >
        {(showAddSingleModal) && (
          <ModalForm onSubmit={handleSingleAdd} className="text-xs">
            <ModalBody>
              <div className="space-y-1">
                <label className="font-semibold text-ui-text">规则类型</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setSingleKind('local')}
                    className={`py-1.5 text-xs font-medium rounded-xl border transition-all ${singleKind === 'local'
                      ? 'bg-ui-text text-white border-ui-text'
                      : 'bg-ui-subtle text-ui-secondary border-ui-border'
                      }`}
                  >
                    本地规则
                  </button>
                  <button
                    type="button"
                    onClick={() => setSingleKind('remote')}
                    className={`py-1.5 text-xs font-medium rounded-xl border transition-all ${singleKind === 'remote'
                      ? 'bg-ui-text text-white border-ui-text'
                      : 'bg-ui-subtle text-ui-secondary border-ui-border'
                      }`}
                  >
                    远程规则集
                  </button>
                </div>
              </div>

              {singleKind === 'local' && (
                <div className="space-y-1">
                  <label className="font-semibold text-ui-text">匹配类型</label>
                  <select
                    value={singleType}
                    onChange={e => setSingleType(e.target.value)}
                    className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                  >
                    <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀)</option>
                    <option value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键字)</option>
                    <option value="DOMAIN">DOMAIN (完整域名)</option>
                    <option value="IP-CIDR">IP-CIDR (IP网段 / 单IP)</option>
                    <option value="SRC-IP-CIDR">SRC-IP-CIDR (源IP网段)</option>
                    <option value="GEOIP">GEOIP (地理位置IP)</option>
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-ui-text">
                    {singleKind === 'remote' ? '规则集 URL 或名称' : '匹配目标 (域名/IP，支持多个)'}
                  </label>
                  {singleKind === 'local' && (
                    <span className="text-[10px] text-ui-muted">支持逗号或换行输入多个 IP/域名</span>
                  )}
                </div>
                <textarea
                  required
                  rows={singleKind === 'remote' ? 2 : 3}
                  placeholder={
                    singleKind === 'remote'
                      ? 'https://raw.githubusercontent.com/.../reject.yaml'
                      : singleType === 'SRC-IP-CIDR'
                        ? '例如局域网指定客户端IP或网段 (按源IP分流):\n192.168.1.50/32\n192.168.1.100/32\n192.168.2.0/24'
                        : '例如私有运维节点:\n192.168.1.100/32\n10.0.0.0/24\nvps.example.com'
                  }
                  value={singlePayload}
                  onChange={e => setSinglePayload(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl font-mono text-xs text-ui-text focus:outline-none focus:border-ui-accent resize-y leading-relaxed"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-ui-text">目标策略组 / 出口</label>
                <select
                  value={singleOutbound}
                  onChange={e => setSingleOutbound(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                >
                  {availableOutbounds.map(g => (
                    <option key={g} value={g}>
                      {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-ui-text">备注名称 (可选)</label>
                <input
                  type="text"
                  value={singleName}
                  onChange={e => setSingleName(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowAddSingleModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                添加
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* Edit Single Rule Modal */}
      <Modal
        open={!!(editingRule)}
        title={(editingRule) ? <>编辑分流规则</> : ''}
        size="lg"
        onClose={() => setEditingRule(null)}
      >
        {(editingRule) && (
          <ModalForm onSubmit={handleEditSave} className="text-xs">
            <ModalBody>
              <div className="space-y-1">
                <label className="font-semibold text-ui-text">规则类型</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditKind('local')}
                    className={`py-1.5 text-xs font-medium rounded-xl border transition-all ${editKind === 'local'
                      ? 'bg-ui-text text-white border-ui-text'
                      : 'bg-ui-subtle text-ui-secondary border-ui-border'
                      }`}
                  >
                    本地规则
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditKind('remote')}
                    className={`py-1.5 text-xs font-medium rounded-xl border transition-all ${editKind === 'remote'
                      ? 'bg-ui-text text-white border-ui-text'
                      : 'bg-ui-subtle text-ui-secondary border-ui-border'
                      }`}
                  >
                    远程规则集
                  </button>
                </div>
              </div>

              {editKind === 'local' && (
                <div className="space-y-1">
                  <label className="font-semibold text-ui-text">匹配类型</label>
                  <select
                    value={editType}
                    onChange={e => setEditType(e.target.value)}
                    className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                  >
                    <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀)</option>
                    <option value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键字)</option>
                    <option value="DOMAIN">DOMAIN (完整域名)</option>
                    <option value="IP-CIDR">IP-CIDR (IP网段 / 单IP)</option>
                    <option value="SRC-IP-CIDR">SRC-IP-CIDR (源IP网段)</option>
                    <option value="GEOIP">GEOIP (地理位置IP)</option>
                    <option value="FINAL">FINAL (漏网之鱼)</option>
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="font-semibold text-ui-text">
                    {editKind === 'remote' ? '规则集 URL 或名称' : '匹配目标 (域名/IP，聚合在一行管理)'}
                  </label>
                  {editKind === 'local' && (
                    <span className="text-[10px] text-ui-muted">支持逗号或换行输入多个 IP/域名</span>
                  )}
                </div>
                <textarea
                  required
                  rows={editKind === 'remote' ? 2 : 4}
                  placeholder={
                    editKind === 'remote'
                      ? 'https://raw.githubusercontent.com/.../reject.yaml'
                      : editType === 'SRC-IP-CIDR'
                        ? '例如局域网指定客户端IP或网段 (按源IP分流):\n192.168.1.50/32\n192.168.1.100/32\n192.168.2.0/24'
                        : '例如私有运维节点:\n192.168.1.100/32\n10.0.0.0/24\nvps.example.com'
                  }
                  value={editPayload}
                  onChange={e => setEditPayload(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl font-mono text-xs text-ui-text focus:outline-none focus:border-ui-accent resize-y leading-relaxed"
                />
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-ui-text">目标策略组 / 出口</label>
                <select
                  value={editOutbound}
                  onChange={e => setEditOutbound(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                >
                  {availableOutbounds.map(g => (
                    <option key={g} value={g}>
                      {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="font-semibold text-ui-text">备注名称</label>
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full px-3 py-2 bg-ui-subtle border border-ui-border rounded-xl text-ui-text focus:outline-none focus:border-ui-accent"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setEditingRule(null)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                保存修改
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>
    </div>
  );
};
