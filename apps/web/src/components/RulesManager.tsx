import { Table, TableHead, TableCell } from './ui/Table';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Select, SelectItem } from './ui/Select';
import { Field, Label } from './ui/Field';
import { Badge } from './ui/Badge';
import { RulesIcon } from './ui/module-icons';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState, useMemo } from 'react';
import {
  Check,
  Edit2,
  FileCode,
  FileText,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
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
            <RulesIcon className="w-5 h-5 text-ui-accent" aria-hidden="true" />
            <h2 className="text-base font-bold text-ui-text">分流规则</h2>
            <Badge tone="accent" className="font-mono border">
              共 {rulesList.length} 组规则
            </Badge>
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
          <Input aria-label="搜索规则名称、域名、IP 或策略去向..."
            type="text"
            placeholder="搜索规则名称、域名、IP 或策略去向..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3.5"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
          {/* Kind Filter */}
          <Select aria-label="规则类型筛选"
            value={kindFilter}
            onValueChange={nextValue => setKindFilter(nextValue as any)}
          >
            <SelectItem value="all">全部类型 ({rulesList.length})</SelectItem>
            <SelectItem value="local">本地规则 ({rulesList.filter(r => r.kind === 'local').length})</SelectItem>
            <SelectItem value="remote">远程规则集 ({rulesList.filter(r => r.kind === 'remote').length})</SelectItem>
          </Select>

          {/* Group Filter */}
          <Select aria-label="目标策略筛选"
            value={groupFilter}
            onValueChange={nextValue => setGroupFilter(nextValue)}
          >
            <SelectItem value="all">全部目标策略</SelectItem>
            {availableOutbounds.map(g => (
              <SelectItem key={g} value={g}>
                {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>

      {/* Rules Table */}
      <div className="ui-panel rounded-2xl bg-ui-surface border border-ui-border overflow-hidden shadow-2xs">

        <Table label="分流规则">
          <thead>
            <tr>
              <TableHead>规则名称 / 备注</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>匹配内容 / 链接</TableHead>
              <TableHead>去向策略组</TableHead>
              <TableHead fixed="right" className="text-right">操作</TableHead>
            </tr>
          </thead>
          <tbody>
            {filteredRules.map(rule => {
              const payloadItems = rule.payload.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
              return (
                <tr key={rule.id}>
                  <TableCell minWidth={160} maxWidth={260} truncate className="font-semibold text-ui-text" title={rule.name}>
                    {rule.name}
                  </TableCell>

                  <TableCell>
                    <Badge
                      tone={rule.kind === 'remote' ? 'success' : rule.type === 'SRC-IP-CIDR' ? 'info' : 'neutral'}
                      className="font-mono"
                    >
                      {rule.type}
                    </Badge>
                  </TableCell>

                  <TableCell minWidth={200} maxWidth={560} title={rule.payload}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {payloadItems.length > 1 && (
                        <Badge tone="accent" className="font-mono border">
                          {payloadItems.length} 项
                        </Badge>
                      )}
                      <span className="font-mono text-ui-secondary text-[11px] truncate select-all">
                        {rule.payload}
                      </span>
                    </div>
                  </TableCell>

                  <TableCell minWidth={180} maxWidth={280}>
                    <Select controlSize="sm" aria-label={`${rule.name}的去向策略组`}
                      value={rule.outbound}
                      onValueChange={nextValue => onUpdateRule(rule.id, { outbound: nextValue })}
                    >
                      {availableOutbounds.map(g => (
                        <SelectItem key={g} value={g}>
                          {g === 'REJECT' ? '🛑 REJECT' : g}
                        </SelectItem>
                      ))}
                    </Select>
                  </TableCell>

                  <TableCell fixed="right" className="text-right">
                    <div className="ui-table-actions">
                      <button
                        onClick={() => openEditModal(rule)}
                        className="p-1 text-ui-muted hover:text-ui-accent hover:bg-ui-accent-soft rounded-lg transition-colors"
                        title="编辑规则"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteRule(rule.id)}
                        className="ui-icon-button-danger p-1 rounded-lg"
                        title="删除规则"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </TableCell>
                </tr>
              );
            })}
          </tbody>
        </Table>


        {filteredRules.length === 0 && (
          <div className="p-12 text-center text-xs text-ui-secondary">
            <p>未找到符合条件的规则</p>
          </div>
        )}
      </div>

      {/* Full Text Editor Modal */}
      <Modal
        open={!!(showFullTextModal)}
        title="分流规则文本编辑"
        description={(showFullTextModal) ? <>以 Clash / YAML 格式编辑规则，支持 DOMAIN-SUFFIX、IP-CIDR、SRC-IP-CIDR 等，用注释 # 备注与目标去向</> : undefined}
        size="wide"
        layout="editor"
        onClose={() => setShowFullTextModal(false)}
      >
        {(showFullTextModal) && (
          <ModalForm onSubmit={handleFullTextSave}>
            <ModalBody editor>
              <div className="flex-1 min-h-0 w-full relative">
                <Textarea variant="code"
                  value={fullRulesText}
                  onChange={e => setFullRulesText(e.target.value)}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full font-mono resize-none"
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
        title="添加单条规则"
        size="lg"
        onClose={() => setShowAddSingleModal(false)}
      >
        {(showAddSingleModal) && (
          <ModalForm onSubmit={handleSingleAdd} className="text-xs">
            <ModalBody>
              <div className="space-y-1">
                <Label>规则类型</Label>
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
                <Field className="space-y-1">
                  <Label>匹配类型</Label>
                  <Select
                    value={singleType}
                    onValueChange={nextValue => setSingleType(nextValue)}
                    className="w-full"
                  >
                    <SelectItem value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀)</SelectItem>
                    <SelectItem value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键字)</SelectItem>
                    <SelectItem value="DOMAIN">DOMAIN (完整域名)</SelectItem>
                    <SelectItem value="IP-CIDR">IP-CIDR (IP网段 / 单IP)</SelectItem>
                    <SelectItem value="SRC-IP-CIDR">SRC-IP-CIDR (源IP网段)</SelectItem>
                    <SelectItem value="GEOIP">GEOIP (地理位置IP)</SelectItem>
                  </Select>
                </Field>
              )}

              <Field className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>
                    {singleKind === 'remote' ? '规则集 URL 或名称' : '匹配目标 (域名/IP，支持多个)'}
                  </Label>
                  {singleKind === 'local' && (
                    <span className="text-[10px] text-ui-muted">支持逗号或换行输入多个 IP/域名</span>
                  )}
                </div>
                <Textarea variant="code"
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
                  className="w-full font-mono resize-y"
                />
              </Field>

              <Field className="space-y-1">
                <Label>目标策略组 / 出口</Label>
                <Select
                  value={singleOutbound}
                  onValueChange={nextValue => setSingleOutbound(nextValue)}
                  className="w-full"
                >
                  {availableOutbounds.map(g => (
                    <SelectItem key={g} value={g}>
                      {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
                    </SelectItem>
                  ))}
                </Select>
              </Field>

              <Field className="space-y-1">
                <Label>备注名称 (可选)</Label>
                <Input
                  type="text"
                  value={singleName}
                  onChange={e => setSingleName(e.target.value)}
                  className="w-full"
                />
              </Field>
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
        title="编辑分流规则"
        size="lg"
        onClose={() => setEditingRule(null)}
      >
        {(editingRule) && (
          <ModalForm onSubmit={handleEditSave} className="text-xs">
            <ModalBody>
              <div className="space-y-1">
                <Label>规则类型</Label>
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
                <Field className="space-y-1">
                  <Label>匹配类型</Label>
                  <Select
                    value={editType}
                    onValueChange={nextValue => setEditType(nextValue)}
                    className="w-full"
                  >
                    <SelectItem value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀)</SelectItem>
                    <SelectItem value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键字)</SelectItem>
                    <SelectItem value="DOMAIN">DOMAIN (完整域名)</SelectItem>
                    <SelectItem value="IP-CIDR">IP-CIDR (IP网段 / 单IP)</SelectItem>
                    <SelectItem value="SRC-IP-CIDR">SRC-IP-CIDR (源IP网段)</SelectItem>
                    <SelectItem value="GEOIP">GEOIP (地理位置IP)</SelectItem>
                    <SelectItem value="FINAL">FINAL (漏网之鱼)</SelectItem>
                  </Select>
                </Field>
              )}

              <Field className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>
                    {editKind === 'remote' ? '规则集 URL 或名称' : '匹配目标 (域名/IP，聚合在一行管理)'}
                  </Label>
                  {editKind === 'local' && (
                    <span className="text-[10px] text-ui-muted">支持逗号或换行输入多个 IP/域名</span>
                  )}
                </div>
                <Textarea variant="code"
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
                  className="w-full font-mono resize-y"
                />
              </Field>

              <Field className="space-y-1">
                <Label>目标策略组 / 出口</Label>
                <Select
                  value={editOutbound}
                  onValueChange={nextValue => setEditOutbound(nextValue)}
                  className="w-full"
                >
                  {availableOutbounds.map(g => (
                    <SelectItem key={g} value={g}>
                      {g === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : g}
                    </SelectItem>
                  ))}
                </Select>
              </Field>

              <Field className="space-y-1">
                <Label>备注名称</Label>
                <Input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="w-full"
                />
              </Field>
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
