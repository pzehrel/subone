import { Table, TableHead, TableCell } from './ui/Table';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Select, SelectItem } from './ui/Select';
import { Field, Label } from './ui/Field';
import { Badge } from './ui/Badge';
import { GroupsIcon } from './ui/module-icons';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState, useMemo } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  Edit2,
  Edit3,
  FileCode,
  FileText,
  Filter,
  Globe,
  Plus,
  Radio,
  Search,
  Sliders,
  Trash2,
  Upload,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { ProxyGroupItem, UnifiedRuleItem, ConfigTemplate } from '../types';

interface RulesetsManagerProps {
  proxyGroups: ProxyGroupItem[];
  rulesList: UnifiedRuleItem[];
  templates?: ConfigTemplate[];
  onAddGroup: (group: Partial<ProxyGroupItem>) => Promise<void>;
  onBatchImportGroups: (text: string, replaceAll?: boolean) => Promise<void>;
  onUpdateGroup: (id: string, updates: Partial<ProxyGroupItem>) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onAddRule: (rule: Partial<UnifiedRuleItem>) => Promise<void>;
  onImportLocalRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onImportRemoteRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onBatchReplaceRules: (text: string, defaultOutbound?: string) => Promise<void>;
  onUpdateRule: (id: string, updates: Partial<UnifiedRuleItem>) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onClearAllRules: () => Promise<void>;
}

export const RulesetsManager: React.FC<RulesetsManagerProps> = ({
  proxyGroups,
  rulesList,
  templates = [],
  onAddGroup,
  onBatchImportGroups,
  onUpdateGroup,
  onDeleteGroup,
  onAddRule,
  onImportLocalRules,
  onImportRemoteRules,
  onBatchReplaceRules,
  onUpdateRule,
  onDeleteRule,
  onClearAllRules,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'local' | 'remote'>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');

  // Modals state
  const [showImportGroupsModal, setShowImportGroupsModal] = useState(false);
  const [groupsImportText, setGroupsImportText] = useState('');
  const [groupsReplaceAll, setGroupsReplaceAll] = useState(false);

  const [showImportLocalModal, setShowImportLocalModal] = useState(false);
  const [localImportText, setLocalImportText] = useState('');
  const [localDefaultOutbound, setLocalDefaultOutbound] = useState(proxyGroups[0]?.name || '🎯 本地直连');

  const [showImportRemoteModal, setShowImportRemoteModal] = useState(false);
  const [remoteImportText, setRemoteImportText] = useState('');
  const [remoteDefaultOutbound, setRemoteDefaultOutbound] = useState(proxyGroups[0]?.name || '🚀 节点选择');

  // Full Text Editor modal state
  const [showFullTextModal, setShowFullTextModal] = useState(false);
  const [fullRulesText, setFullRulesText] = useState('');
  const [copiedFullText, setCopiedFullText] = useState(false);

  const [showAddSingleModal, setShowAddSingleModal] = useState(false);
  const [singleName, setSingleName] = useState('');
  const [singleKind, setSingleKind] = useState<'local' | 'remote'>('local');
  const [singleType, setSingleType] = useState<any>('DOMAIN-SUFFIX');
  const [singlePayload, setSinglePayload] = useState('');
  const [singleOutbound, setSingleOutbound] = useState(proxyGroups[0]?.name || '🎯 本地直连');

  // Group Management modal
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupType, setNewGroupType] = useState<'select' | 'urltest' | 'direct'>('select');

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
    await onBatchReplaceRules(fullRulesText, proxyGroups[0]?.name || '🎯 本地直连');
    setShowFullTextModal(false);
  };

  // Filter rules
  const filteredRules = rulesList.filter(rule => {
    const matchesSearch =
      rule.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.payload.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.outbound.toLowerCase().includes(searchTerm.toLowerCase()) ||
      rule.type.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesKind = kindFilter === 'all' || rule.kind === kindFilter;
    const matchesGroup = groupFilter === 'all' || rule.outbound === groupFilter;

    return matchesSearch && matchesKind && matchesGroup;
  });

  const handleImportGroupsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupsImportText.trim()) return;
    await onBatchImportGroups(groupsImportText, groupsReplaceAll);
    setGroupsImportText('');
    setShowImportGroupsModal(false);
  };

  const handleImportLocalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localImportText.trim()) return;
    await onImportLocalRules(localImportText, localDefaultOutbound);
    setLocalImportText('');
    setShowImportLocalModal(false);
  };

  const handleImportRemoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remoteImportText.trim()) return;
    await onImportRemoteRules(remoteImportText, remoteDefaultOutbound);
    setRemoteImportText('');
    setShowImportRemoteModal(false);
  };

  const handleAddSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singlePayload.trim()) return;
    await onAddRule({
      name: singleName.trim() || `${singleType}: ${singlePayload.trim()}`,
      kind: singleKind,
      type: singleType,
      payload: singlePayload.trim(),
      outbound: singleOutbound,
      enabled: true,
    });
    setSingleName('');
    setSinglePayload('');
    setShowAddSingleModal(false);
  };

  const handleAddGroupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    await onAddGroup({
      name: newGroupName.trim(),
      type: newGroupType,
      proxies: ['🚀 节点选择', '🎯 本地直连'],
    });
    setNewGroupName('');
    setShowGroupModal(false);
  };

  const getTypeTone = (type: string, kind: string): 'neutral' | 'accent' | 'success' | 'info' => {
    if (kind === 'remote') return 'info';
    if (type.includes('DOMAIN')) return 'success';
    if (type === 'GEOIP') return 'info';
    if (type.includes('IP')) return 'accent';
    return 'neutral';
  };

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* 1. Outbound Groups Top Overview Bar */}
      <div className="ui-panel p-4 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GroupsIcon className="w-4 h-4 text-ui-accent" aria-hidden="true" />
            <h3 className="text-xs font-bold text-ui-text">出口策略分组清单 (Proxy Groups)</h3>
            <span className="text-[11px] text-ui-secondary">
              共 {proxyGroups.length} 个策略分组（分流规则的目标出口）
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImportGroupsModal(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold ui-button-secondary rounded-xl"
              title="直接粘贴 YAML/JSON/MCF 批量添加分组"
            >
              <Upload className="w-3.5 h-3.5 text-ui-accent" />
              <span>批量贴入分组</span>
            </button>
            <button
              onClick={() => setShowGroupModal(true)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold ui-button-secondary rounded-xl"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加分组</span>
            </button>
          </div>
        </div>

        {/* Group Badges List */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          {proxyGroups.map(grp => (
            <div
              key={grp.id}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-ui-subtle border border-ui-border rounded-xl text-xs text-ui-text hover:border-[#D5CFC5] transition-all group"
            >
              <span className="font-semibold">{grp.name}</span>
              <Badge tone="neutral" className="font-mono">
                {grp.type}
              </Badge>
              <button
                onClick={() => onDeleteGroup(grp.id)}
                className="opacity-0 group-hover:opacity-100 p-0.5 text-[#A8483B] hover:text-red-700 transition-opacity ml-1"
                title="直接删除分组"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {proxyGroups.length === 0 && (
            <div className="text-xs text-ui-muted py-2">暂无策略组，请点击上方按钮添加或批量贴入</div>
          )}
        </div>
      </div>

      {/* 2. Rules Control Bar & Action Buttons */}
      <div className="ui-panel p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:max-w-2xl">
          <div className="relative w-full min-w-0 sm:min-w-[180px] sm:flex-1">
            <Search className="w-4 h-4 text-ui-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
            <Input aria-label="搜索规则名称、域名、IP 或 URL..."
              type="text"
              placeholder="搜索规则名称、域名、IP 或 URL..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3.5"
            />
          </div>

          <div className="flex w-full min-w-0 gap-2 sm:w-auto sm:max-w-[340px]">
            <Select aria-label="规则类型筛选"
              value={kindFilter}
              onValueChange={nextValue => setKindFilter(nextValue as any)}
              className="min-w-0 flex-1 cursor-pointer"
            >
              <SelectItem value="all">全部类型 ({rulesList.length})</SelectItem>
              <SelectItem value="local">仅本地规则 ({rulesList.filter(r => r.kind === 'local').length})</SelectItem>
              <SelectItem value="remote">仅远程规则集 ({rulesList.filter(r => r.kind === 'remote').length})</SelectItem>
            </Select>

            <Select aria-label="目标策略筛选"
              value={groupFilter}
              onValueChange={nextValue => setGroupFilter(nextValue)}
              className="min-w-0 flex-1 cursor-pointer"
            >
              <SelectItem value="all">全部分组去向</SelectItem>
              {availableOutbounds.map(ob => (
                <SelectItem key={ob} value={ob}>{ob === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : ob}</SelectItem>
              ))}
            </Select>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
          <button
            onClick={openFullTextEditor}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ui-button-secondary rounded-xl whitespace-nowrap bg-[#FAF0E6] text-[#B85D38] border-[#E8D7C7]"
            title="将全部规则以纯文本直接查看与编辑"
          >
            <Edit3 className="w-3.5 h-3.5 text-ui-accent" />
            <span>📝 文本编辑</span>
          </button>

          <button
            onClick={() => setShowImportLocalModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ui-button-secondary rounded-xl whitespace-nowrap"
            title="直接贴入大段本地规则 (YAML/JSON/文本)"
          >
            <FileText className="w-3.5 h-3.5 text-[#367A68]" />
            <span>贴入本地规则</span>
          </button>

          <button
            onClick={() => setShowImportRemoteModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ui-button-secondary rounded-xl whitespace-nowrap"
            title="直接贴入远程规则集 (YAML/JSON/URL列表)"
          >
            <Globe className="w-3.5 h-3.5 text-[#635588]" />
            <span>贴入远程规则集</span>
          </button>

          <button
            onClick={() => setShowAddSingleModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold ui-button-primary rounded-xl whitespace-nowrap shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>新建单条</span>
          </button>
        </div>
      </div>

      {/* 3. Rules Matrix Table */}
      <div className="ui-panel rounded-2xl overflow-hidden shadow-sm">

        <Table label="分流规则">
          <thead>
            <tr>
              <TableHead className="text-center">状态</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>规则名称 & 匹配条件 / URL</TableHead>
              <TableHead>去向策略组 (可秒切)</TableHead>
              <TableHead fixed="right" className="text-right">操作</TableHead>
            </tr>
          </thead>
          <tbody>
            {filteredRules.map(rule => (
              <tr data-disabled={!rule.enabled || undefined}
                key={rule.id}
              >
                {/* Status Toggle */}
                <TableCell className="text-center">
                  <button
                    onClick={() => onUpdateRule(rule.id, { enabled: !rule.enabled })}
                    title={rule.enabled ? '点击禁用' : '点击启用'}
                  >
                    {rule.enabled ? (
                      <CheckCircle2 className="w-4 h-4 text-[#367A68]" />
                    ) : (
                      <XCircle className="w-4 h-4 text-ui-muted" />
                    )}
                  </button>
                </TableCell>

                {/* Rule Type Badge */}
                <TableCell>
                  <Badge tone={getTypeTone(rule.type, rule.kind)} className="font-mono">
                    {rule.kind === 'remote' ? 'RULE-SET' : rule.type}
                  </Badge>
                </TableCell>

                {/* Name & Payload */}
                <TableCell minWidth={220} maxWidth={560}>
                  <div className="font-bold text-ui-text mb-0.5 truncate">{rule.name}</div>
                  <div className="font-mono text-[11px] text-ui-secondary truncate max-w-xl select-all">
                    {rule.payload}
                  </div>
                </TableCell>

                {/* Target Outbound Dropdown Selector (Core Feature!) */}
                <TableCell minWidth={180} maxWidth={280}>
                  <div className="relative">
                    <Select controlSize="sm" aria-label={`${rule.name}的去向策略组`}
                      value={rule.outbound}
                      onValueChange={nextValue => onUpdateRule(rule.id, { outbound: nextValue })}
                      className="w-full cursor-pointer"
                    >
                      {availableOutbounds.map(ob => (
                        <SelectItem key={ob} value={ob}>{ob === 'REJECT' ? '🛑 REJECT' : `➔ ${ob}`}</SelectItem>
                      ))}
                    </Select>

                  </div>
                </TableCell>

                {/* Actions */}
                <TableCell fixed="right" className="text-right">
                  <button
                    onClick={() => onDeleteRule(rule.id)}
                    className="ui-icon-button-danger p-1.5 rounded-lg"
                    title="直接删除规则"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </TableCell>
              </tr>
            ))}

            {filteredRules.length === 0 && (
              <tr>
                <TableCell colSpan={5} className="text-center text-ui-muted">
                  未找到匹配的规则条目，请点击上方按钮贴入或新建
                </TableCell>
              </tr>
            )}
          </tbody>
        </Table>

      </div>

      {/* MODAL: Full Text Rules Editor (文本直接编辑) */}
      <Modal
        open={!!(showFullTextModal)}
        title="规则文本编辑"
        size="wide"
        layout="editor"
        onClose={() => setShowFullTextModal(false)}
      >
        {(showFullTextModal) && (
          <ModalForm onSubmit={handleFullTextSave}>
            <ModalBody editor>
              <div className="flex items-center justify-between text-xs text-ui-secondary">
                <div className="flex items-center gap-2">
                  <span>支持格式：<code className="bg-ui-hover px-1 py-0.5 rounded text-[11px]">- TYPE,payload,去向策略组  # 备注名称</code></span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(fullRulesText);
                    setCopiedFullText(true);
                    setTimeout(() => setCopiedFullText(false), 2000);
                  }}
                  className="flex items-center gap-1 text-[11px] font-semibold text-ui-accent hover:underline"
                >
                  {copiedFullText ? <Check className="w-3.5 h-3.5 text-[#367A68]" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedFullText ? '已复制全文' : '复制全文'}</span>
                </button>
              </div>

              <div className="flex-1 relative min-h-0 bg-ui-surface rounded-xl border border-ui-border overflow-hidden">
                <Textarea variant="code"
                  required
                  value={fullRulesText}
                  onChange={e => setFullRulesText(e.target.value)}
                  spellCheck={false}
                  placeholder={`# 示例规则：\n- IP-CIDR,192.168.1.100/32,🎯 本地直连,no-resolve  # 本地NAS\n- IP-CIDR,10.0.0.50/32,💻 远程运维,no-resolve  # 远程跳板机\n- DOMAIN-SUFFIX,apple.com,🎯 本地直连  # Apple 服务\n- RULE-SET,https://raw.githubusercontent.com/.../ai.srs,🤖 AI 服务`}
                  className="w-full h-full font-mono resize-none"
                />
              </div>
            </ModalBody>
            <ModalFooter className="justify-between">
              <span className="text-[11px] text-ui-muted">
                💡 提示：若规则中出现新的去向分组名称（如「💻 远程运维」），系统将自动创建该策略组。
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowFullTextModal(false)}
                  className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-xs font-bold ui-button-primary rounded-xl shadow-xs"
                >
                  保存并应用
                </button>
              </div>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* MODAL 1: Batch Import Groups */}
      <Modal
        open={!!(showImportGroupsModal)}
        title="批量贴入策略分组 (Proxy Groups)"
        description={(showImportGroupsModal) ? <>支持直接粘贴 YAML proxy-groups、JSON outbounds 或 Loon MCF 文本行</> : undefined}
        size="wide"
        layout="editor"
        onClose={() => setShowImportGroupsModal(false)}
      >
        {(showImportGroupsModal) && (
          <ModalForm onSubmit={handleImportGroupsSubmit}>
            <ModalBody editor>
              <div className="flex-1 min-h-0 w-full relative">
                <Textarea variant="code"
                  required
                  placeholder={`支持粘贴 YAML 列表：\n- name: 🤖 AI 服务\n  type: select\n  proxies:\n    - 🚀 节点选择\n    - 🇺🇸 美国节点\n\n或 Loon 格式：\n📹 YouTube = select,🚀 节点选择,🇺🇸 美国节点\n\n或直接逗号分隔分组名称列表...`}
                  value={groupsImportText}
                  onChange={e => setGroupsImportText(e.target.value)}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full font-mono resize-none"
                />
              </div>
            </ModalBody>
            <ModalFooter className="justify-between">
              <Label className="flex items-center gap-2 cursor-pointer">
                <Input
                  type="checkbox"
                  checked={groupsReplaceAll}
                  onChange={e => setGroupsReplaceAll(e.target.checked)}
                />
                <span>清空并替换现有所有分组（默认追加合并）</span>
              </Label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportGroupsModal(false)}
                  className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-6 py-2 text-xs font-semibold ui-button-primary rounded-xl"
                >
                  解析并导入策略组
                </button>
              </div>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* MODAL 2: Batch Import Local Rules */}
      <Modal
        open={!!(showImportLocalModal)}
        title="批量贴入本地规则 (Local Rules)"
        description={(showImportLocalModal) ? <>支持粘贴 Clash YAML rules、Sing-box JSON 路由规则或 Surge/Loon 文本行</> : undefined}
        size="wide"
        layout="editor"
        onClose={() => setShowImportLocalModal(false)}
      >
        {(showImportLocalModal) && (
          <ModalForm onSubmit={handleImportLocalSubmit}>
            <ModalBody editor>
              <Field className="shrink-0">
                <Label className="block">
                  默认去向分组（若粘贴的规则中已指定去向，则以规则中的去向为准）
                </Label>
                <Select
                  value={localDefaultOutbound}
                  onValueChange={nextValue => setLocalDefaultOutbound(nextValue)}
                  className="w-full"
                >
                  {availableOutbounds.map(ob => (
                    <SelectItem key={ob} value={ob}>{ob === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : `➔ ${ob}`}</SelectItem>
                  ))}
                </Select>
              </Field>

              <div className="flex-1 min-h-0 w-full relative">
                <Textarea variant="code"
                  required
                  placeholder={`- IP-CIDR,192.168.1.100/32,🎯 本地直连,no-resolve  # 本地NAS\n- IP-CIDR,10.0.0.50/32,💻 远程运维,no-resolve  # 远程跳板机\n- DOMAIN-SUFFIX,apple.com,🎯 本地直连\n- DOMAIN-KEYWORD,torrent,🎯 本地直连\n- GEOIP,CN,🎯 本地直连`}
                  value={localImportText}
                  onChange={e => setLocalImportText(e.target.value)}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full font-mono resize-none"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowImportLocalModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-6 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                解析并导入规则
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* MODAL 3: Batch Import Remote Rules */}
      <Modal
        open={!!(showImportRemoteModal)}
        title="批量贴入远程规则集 (Remote Rule-Sets)"
        description={(showImportRemoteModal) ? <>支持粘贴 Sing-box rule_set JSON、Clash rule-providers 或 Loon [Remote Rule] 列表</> : undefined}
        size="wide"
        layout="editor"
        onClose={() => setShowImportRemoteModal(false)}
      >
        {(showImportRemoteModal) && (
          <ModalForm onSubmit={handleImportRemoteSubmit}>
            <ModalBody editor>
              <Field className="shrink-0">
                <Label className="block">
                  默认去向分组（若粘贴的规则中已指定去向，则以规则中的去向为准）
                </Label>
                <Select
                  value={remoteDefaultOutbound}
                  onValueChange={nextValue => setRemoteDefaultOutbound(nextValue)}
                  className="w-full"
                >
                  {availableOutbounds.map(ob => (
                    <SelectItem key={ob} value={ob}>{ob === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : `➔ ${ob}`}</SelectItem>
                  ))}
                </Select>
              </Field>

              <div className="flex-1 min-h-0 w-full relative">
                <Textarea variant="code"
                  required
                  placeholder={`https://gh-proxy.com/https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/category-ai-!cn.srs, policy=🤖 AI 服务, tag=AI服务\nhttps://gh-proxy.com/https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/youtube.srs, policy=📹 YouTube, tag=YouTube\nhttps://gh-proxy.com/https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs, policy=🇨🇳 国内服务, tag=国内直连`}
                  value={remoteImportText}
                  onChange={e => setRemoteImportText(e.target.value)}
                  spellCheck={false}
                  className="absolute inset-0 w-full h-full font-mono resize-none"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowImportRemoteModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-6 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                解析并导入规则集
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* MODAL 4: Create Single Rule */}
      <Modal
        open={!!(showAddSingleModal)}
        title="新建单条分流规则"
        size="lg"
        onClose={() => setShowAddSingleModal(false)}
      >
        {(showAddSingleModal) && (
          <ModalForm onSubmit={handleAddSingleSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">规则名称 / 备注 (可选)</Label>
                <Input
                  type="text"
                  value={singleName}
                  onChange={e => setSingleName(e.target.value)}
                  className="w-full"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <Label className="block">规则类型</Label>
                  <Select
                    value={singleType}
                    onValueChange={nextValue => {
                      const val = nextValue as any;
                      setSingleType(val);
                      if (val === 'RULE-SET') setSingleKind('remote');
                      else setSingleKind('local');
                    }}
                    className="w-full"
                  >
                    <SelectItem value="DOMAIN-SUFFIX">DOMAIN-SUFFIX (域名后缀)</SelectItem>
                    <SelectItem value="DOMAIN-KEYWORD">DOMAIN-KEYWORD (域名关键字)</SelectItem>
                    <SelectItem value="DOMAIN">DOMAIN (完整域名)</SelectItem>
                    <SelectItem value="IP-CIDR">IP-CIDR (IP/网段)</SelectItem>
                    <SelectItem value="SRC-IP-CIDR">SRC-IP-CIDR (源IP/网段)</SelectItem>
                    <SelectItem value="GEOIP">GEOIP (地理IP库)</SelectItem>
                    <SelectItem value="RULE-SET">RULE-SET (远程规则集)</SelectItem>
                    <SelectItem value="FINAL">FINAL / MATCH (最终规则)</SelectItem>
                  </Select>
                </Field>

                <Field>
                  <Label className="block">去向策略组</Label>
                  <Select
                    value={singleOutbound}
                    onValueChange={nextValue => setSingleOutbound(nextValue)}
                    className="w-full"
                  >
                    {availableOutbounds.map(ob => (
                      <SelectItem key={ob} value={ob}>{ob === 'REJECT' ? '🛑 REJECT (拦截丢弃)' : `➔ ${ob}`}</SelectItem>
                    ))}
                  </Select>
                </Field>
              </div>

              <Field>
                <Label className="block">
                  匹配参数 / 规则内容 / 远程 URL
                </Label>
                <Input
                  type="text"
                  required
                  value={singlePayload}
                  onChange={e => setSinglePayload(e.target.value)}
                  className="w-full font-mono"
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
                className="px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                确认添加
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* MODAL 5: Create New Proxy Group */}
      <Modal
        open={!!(showGroupModal)}
        title="添加策略分组"
        size="md"
        onClose={() => setShowGroupModal(false)}
      >
        {(showGroupModal) && (
          <ModalForm onSubmit={handleAddGroupSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">分组名称 (支持 Emoji)</Label>
                <Input
                  type="text"
                  required
                  placeholder=""
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  className="w-full"
                />
              </Field>

              <Field>
                <Label className="block">策略组类型</Label>
                <Select
                  value={newGroupType}
                  onValueChange={nextValue => setNewGroupType(nextValue as any)}
                  className="w-full"
                >
                  <SelectItem value="select">手动选择 (Select)</SelectItem>
                  <SelectItem value="urltest">自动测速 (URL-Test)</SelectItem>
                  <SelectItem value="direct">本地直连 (Direct)</SelectItem>
                </Select>
              </Field>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowGroupModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                确认添加
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>
    </div>
  );
};
