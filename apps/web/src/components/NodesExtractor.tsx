import { Input } from './ui/Input';
import { Select, SelectItem } from './ui/Select';
import { Field, Label } from './ui/Field';
import { Badge } from './ui/Badge';
import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit2,
  Filter,
  Globe,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Sliders,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import { CountryPatternRule, ExtractionRule, ProxyNode, SubscriptionSource } from '../types';

interface NodesExtractorProps {
  nodes: ProxyNode[];
  rules: ExtractionRule[];
  countryRules: CountryPatternRule[];
  sources: SubscriptionSource[];
  isRefreshing: boolean;
  onRefreshAll: () => Promise<void>;
  onAddRule: (rule: Partial<ExtractionRule>) => Promise<void>;
  onUpdateRule: (id: string, updates: Partial<ExtractionRule>) => Promise<void>;
  onDeleteRule: (id: string) => Promise<void>;
  onAddCountryRule: (rule: Partial<CountryPatternRule>) => Promise<void>;
  onUpdateCountryRule: (id: string, updates: Partial<CountryPatternRule>) => Promise<void>;
  onDeleteCountryRule: (id: string) => Promise<void>;
  onResetCountryRules: () => Promise<void>;
}

export const NodesExtractor: React.FC<NodesExtractorProps> = ({
  nodes,
  rules,
  countryRules,
  sources,
  isRefreshing,
  onRefreshAll,
  onAddRule,
  onUpdateRule,
  onDeleteRule,
  onAddCountryRule,
  onUpdateCountryRule,
  onDeleteCountryRule,
  onResetCountryRules,
}) => {
  // Filter & Search states
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<string>('ALL');
  const [selectedType, setSelectedType] = useState<string>('ALL');

  // Collapse states for rules sections
  const [showCountryRules, setShowCountryRules] = useState(false);
  const [showExtractionRules, setShowExtractionRules] = useState(false);

  // Modals
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<ExtractionRule | null>(null);

  const [showCountryModal, setShowCountryModal] = useState(false);
  const [editingCountryRule, setEditingCountryRule] = useState<CountryPatternRule | null>(null);

  // Rule Form States
  const [ruleName, setRuleName] = useState('');
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [targetCountries, setTargetCountries] = useState<string[]>([]);
  const [includeRegex, setIncludeRegex] = useState('');
  const [excludeRegex, setExcludeRegex] = useState('');
  const [prefix, setPrefix] = useState('');
  const [suffix, setSuffix] = useState('');
  const [replaceFrom, setReplaceFrom] = useState('');
  const [replaceTo, setReplaceTo] = useState('');

  // Country Rule Form States
  const [cCode, setCCode] = useState('');
  const [cName, setCName] = useState('');
  const [cEmoji, setCEmoji] = useState('🌐');
  const [cPattern, setCPattern] = useState('');
  const [cGroupName, setCGroupName] = useState('');

  // Country count stats
  const countryStats: Record<string, { count: number; emoji: string; name: string }> = {};
  nodes.forEach(n => {
    const code = n.countryCode || 'OTHER';
    if (!countryStats[code]) {
      countryStats[code] = {
        count: 0,
        emoji: n.countryEmoji || '🌐',
        name: code === 'OTHER' ? '其他' : code,
      };
    }
    countryStats[code].count++;
  });

  const availableCountries = Array.from(new Set(nodes.map(n => n.countryCode || 'OTHER'))).filter(Boolean);
  const availableTypes = Array.from(new Set(nodes.map(n => n.type))).filter(Boolean);

  const filteredNodes = nodes.filter(node => {
    const matchesSearch =
      node.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      node.server.toLowerCase().includes(searchTerm.toLowerCase()) ||
      String(node.port).includes(searchTerm);

    const matchesCountry =
      selectedCountry === 'ALL' || (node.countryCode || 'OTHER') === selectedCountry;

    const matchesType = selectedType === 'ALL' || node.type === selectedType;

    return matchesSearch && matchesCountry && matchesType;
  });

  // Extraction Rule Handlers
  const openAddRule = () => {
    setRuleName('');
    setSelectedSources([]);
    setTargetCountries([]);
    setIncludeRegex('');
    setExcludeRegex('');
    setPrefix('');
    setSuffix('');
    setReplaceFrom('');
    setReplaceTo('');
    setEditingRule(null);
    setShowRuleModal(true);
  };

  const openEditRule = (rule: ExtractionRule) => {
    setEditingRule(rule);
    setRuleName(rule.name);
    setSelectedSources(rule.sourceIds || []);
    setTargetCountries(rule.targetCountries || []);
    setIncludeRegex(rule.includeRegex || '');
    setExcludeRegex(rule.excludeRegex || '');
    setPrefix(rule.renamePattern?.prefix || '');
    setSuffix(rule.renamePattern?.suffix || '');
    setReplaceFrom(rule.renamePattern?.replaceFrom || '');
    setReplaceTo(rule.renamePattern?.replaceTo || '');
    setShowRuleModal(true);
  };

  const handleRuleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim()) return;

    const payload: Partial<ExtractionRule> = {
      name: ruleName.trim(),
      enabled: editingRule ? editingRule.enabled : true,
      sourceIds: selectedSources.length > 0 ? selectedSources : undefined,
      targetCountries: targetCountries.length > 0 ? targetCountries : undefined,
      includeRegex: includeRegex.trim() || undefined,
      excludeRegex: excludeRegex.trim() || undefined,
      renamePattern: (prefix || suffix || replaceFrom) ? {
        prefix: prefix.trim() || undefined,
        suffix: suffix.trim() || undefined,
        replaceFrom: replaceFrom || undefined,
        replaceTo: replaceTo || undefined,
      } : undefined,
    };

    if (editingRule) {
      await onUpdateRule(editingRule.id, payload);
    } else {
      await onAddRule(payload);
    }
    setShowRuleModal(false);
  };

  // Country Rule Handlers
  const openAddCountry = () => {
    setCCode('');
    setCName('');
    setCEmoji('🌐');
    setCPattern('');
    setCGroupName('');
    setEditingCountryRule(null);
    setShowCountryModal(true);
  };

  const openEditCountry = (cr: CountryPatternRule) => {
    setEditingCountryRule(cr);
    setCCode(cr.code);
    setCName(cr.name);
    setCEmoji(cr.emoji);
    setCPattern(cr.pattern);
    setCGroupName(cr.groupName || `${cr.emoji} ${cr.name}节点`);
    setShowCountryModal(true);
  };

  const handleCountrySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cCode.trim() || !cName.trim() || !cPattern.trim()) return;

    const payload: Partial<CountryPatternRule> = {
      code: cCode.trim().toUpperCase(),
      name: cName.trim(),
      emoji: cEmoji.trim() || '🌐',
      pattern: cPattern.trim(),
      groupName: cGroupName.trim() || `${cEmoji.trim() || '🌐'} ${cName.trim()}节点`,
    };

    if (editingCountryRule) {
      await onUpdateCountryRule(editingCountryRule.id, payload);
    } else {
      await onAddCountryRule(payload);
    }
    setShowCountryModal(false);
  };

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      {/* Top Main Action & Refresh Header */}
      <div className="ui-panel p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <h2 className="text-lg font-bold text-ui-text">节点池与抽取规则流水线</h2>
            <Badge tone="success" className="border">
              {nodes.length} 个有效节点
            </Badge>
          </div>
          <p className="text-xs text-ui-secondary">
            管理地区识别规则、关键字/正则过滤与重命名
          </p>

          {/* Country Quick Stat Badges */}
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            {Object.entries(countryStats).map(([code, data]) => (
              <button
                key={code}
                onClick={() => setSelectedCountry(selectedCountry === code ? 'ALL' : code)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono transition-all ${selectedCountry === code
                  ? 'bg-ui-accent text-white font-bold shadow-xs'
                  : 'bg-[#F5F2EC] text-ui-secondary hover:bg-[#EDE8DE] border border-ui-border'
                  }`}
              >
                <span>{data.emoji}</span>
                <span>{data.name}</span>
                <span className="opacity-75 font-sans">({data.count})</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 self-start md:self-center">
          <button
            onClick={onRefreshAll}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold ui-button-primary rounded-xl shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>{isRefreshing ? '正在拉取并分组...' : '🔄 立即拉取并执行抽取分组'}</span>
          </button>
        </div>
      </div>

      {/* Rules Config Accordions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Section 1: Country Grouping Rules */}
        <div className="ui-panel rounded-2xl overflow-hidden flex flex-col">
          <button
            onClick={() => setShowCountryRules(!showCountryRules)}
            className="w-full px-4 py-3.5 bg-ui-subtle hover:bg-[#F3EFEA] border-b border-ui-border flex items-center justify-between transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Globe className="w-4 h-4 text-[#367A68]" />
              <div>
                <h3 className="text-xs font-bold text-ui-text">🌍 国家/地区自动分类与分组规则</h3>
                <p className="text-[11px] text-ui-secondary">
                  已配置 {countryRules.length} 个地区正则匹配与对应策略分组
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-ui-secondary">
              <span className="text-[11px] font-medium hidden sm:inline">
                {showCountryRules ? '收起规则' : '查看/编辑'}
              </span>
              {showCountryRules ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showCountryRules && (
            <div className="p-4 space-y-3 bg-ui-surface animate-in fade-in duration-150 flex-1">
              <div className="flex items-center justify-between pb-2 border-b border-ui-divider">
                <span className="text-[11px] text-ui-secondary">匹配节点名称识别国家，并自动分流至对应测速策略组</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onResetCountryRules()}
                    className="flex items-center gap-1 text-[11px] text-ui-secondary hover:text-ui-text"
                    title="重置为默认规则"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>恢复默认</span>
                  </button>
                  <button
                    onClick={openAddCountry}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold ui-button-secondary rounded-lg"
                  >
                    <Plus className="w-3 h-3 text-ui-accent" />
                    <span>添加地区</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {countryRules.map(cr => (
                  <div
                    key={cr.id}
                    className="bg-ui-subtle p-2.5 rounded-xl border border-ui-divider flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <span className="text-base">{cr.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-ui-text">{cr.name}</span>
                          <Badge tone="neutral" className="font-mono">
                            {cr.code}
                          </Badge>
                          {cr.groupName && (
                            <Badge tone="success" className="font-medium truncate">
                              ➔ {cr.groupName}
                            </Badge>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-ui-secondary truncate mt-0.5" title={cr.pattern}>
                          {cr.pattern}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditCountry(cr)}
                        className="p-1 text-ui-secondary hover:text-ui-text rounded-lg hover:bg-ui-surface"
                        title="编辑地区规则"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => onDeleteCountryRule(cr.id)}
                        className="ui-icon-button-danger p-1 rounded-lg"
                        title="删除地区规则"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Custom Extraction & Rename Rules */}
        <div className="ui-panel rounded-2xl overflow-hidden flex flex-col">
          <button
            onClick={() => setShowExtractionRules(!showExtractionRules)}
            className="w-full px-4 py-3.5 bg-ui-subtle hover:bg-[#F3EFEA] border-b border-ui-border flex items-center justify-between transition-colors text-left"
          >
            <div className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 text-ui-accent" />
              <div>
                <h3 className="text-xs font-bold text-ui-text">⚡ 自定义抽取与重命名规则</h3>
                <p className="text-[11px] text-ui-secondary">
                  已配置 {rules.length} 条节点白名单过滤、正则清洗与改名规则
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-ui-secondary">
              <span className="text-[11px] font-medium hidden sm:inline">
                {showExtractionRules ? '收起规则' : '查看/编辑'}
              </span>
              {showExtractionRules ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </div>
          </button>

          {showExtractionRules && (
            <div className="p-4 space-y-3 bg-ui-surface animate-in fade-in duration-150 flex-1">
              <div className="flex items-center justify-between pb-2 border-b border-ui-divider">
                <span className="text-[11px] text-ui-secondary">规则按顺序执行；若无启用规则则默认保留全部节点</span>
                <button
                  onClick={openAddRule}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold ui-button-secondary rounded-lg"
                >
                  <Plus className="w-3 h-3 text-ui-accent" />
                  <span>添加抽取规则</span>
                </button>
              </div>

              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {rules.map(rule => (
                  <div
                    key={rule.id}
                    className={`p-2.5 rounded-xl border flex items-center justify-between gap-3 text-xs transition-all ${rule.enabled ? 'bg-ui-subtle border-ui-divider' : 'bg-[#F7F5F2] border-ui-border opacity-60'
                      }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <button
                        onClick={() => onUpdateRule(rule.id, { enabled: !rule.enabled })}
                        className="mt-0.5"
                        title={rule.enabled ? '点击禁用' : '点击启用'}
                      >
                        {rule.enabled ? (
                          <CheckCircle2 className="w-4 h-4 text-[#367A68]" />
                        ) : (
                          <XCircle className="w-4 h-4 text-ui-muted" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-ui-text">{rule.name}</span>
                          {rule.excludeRegex && (
                            <Badge tone="danger" className="font-mono">
                              排除: {rule.excludeRegex}
                            </Badge>
                          )}
                          {rule.includeRegex && (
                            <Badge tone="success" className="font-mono">
                              包含: {rule.includeRegex}
                            </Badge>
                          )}
                        </div>
                        {rule.renamePattern && (
                          <div className="text-[11px] font-mono text-ui-secondary mt-0.5 truncate">
                            重命名: {rule.renamePattern.prefix ? `[前缀: ${rule.renamePattern.prefix}] ` : ''}
                            {rule.renamePattern.suffix ? `[后缀: ${rule.renamePattern.suffix}] ` : ''}
                            {rule.renamePattern.replaceFrom ? `[替换: ${rule.renamePattern.replaceFrom} -> ${rule.renamePattern.replaceTo || ''}]` : ''}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditRule(rule)}
                        className="p-1 text-ui-secondary hover:text-ui-text rounded-lg hover:bg-ui-surface"
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
                  </div>
                ))}

                {rules.length === 0 && (
                  <div className="text-center py-6 text-xs text-ui-muted">暂无自定义抽取规则，默认保留所有节点</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Nodes Search, Filters & Grid Display */}
      <div className="space-y-4">
        <div className="ui-panel p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-ui-muted absolute left-3.5 top-1/2 -translate-y-1/2" />
            <Input aria-label="搜索节点名称、IP 或 端口..."
              type="text"
              placeholder="搜索节点名称、IP 或 端口..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4"
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
            <Select aria-label="国家或地区筛选"
              value={selectedCountry}
              onValueChange={nextValue => setSelectedCountry(nextValue)}
              className="cursor-pointer"
            >
              <SelectItem value="ALL">全部地区 ({nodes.length})</SelectItem>
              {availableCountries.map(c => (
                <SelectItem key={c} value={c}>
                  {c} ({nodes.filter(n => (n.countryCode || 'OTHER') === c).length})
                </SelectItem>
              ))}
            </Select>

            <Select aria-label="节点协议筛选"
              value={selectedType}
              onValueChange={nextValue => setSelectedType(nextValue)}
              className="cursor-pointer"
            >
              <SelectItem value="ALL">全部协议</SelectItem>
              {availableTypes.map(t => (
                <SelectItem key={t} value={t}>
                  {t.toUpperCase()}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>

        {/* Nodes Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredNodes.map(node => (
            <div
              key={node.id}
              className="ui-panel p-4 rounded-2xl hover:border-[#D5CFC5] transition-all flex flex-col justify-between gap-3 group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xl">{node.countryEmoji || '🌐'}</span>
                  <div className="min-w-0">
                    <h4 className="text-xs font-bold text-ui-text truncate group-hover:text-ui-accent transition-colors">
                      {node.name}
                    </h4>
                    <div className="text-[11px] font-mono text-ui-secondary truncate">
                      {node.server}:{node.port}
                    </div>
                  </div>
                </div>
                <Badge tone="neutral" className="font-mono uppercase border">
                  {node.type}
                </Badge>
              </div>

              <div className="flex items-center justify-between text-[11px] text-ui-muted border-t border-ui-divider pt-2">
                <div className="flex items-center gap-2 min-w-0">
                  {node.sourceName && (
                    <span className="truncate max-w-[130px]" title={node.sourceName}>
                      🏷️ {node.sourceName}
                    </span>
                  )}
                  {node.countryCode && (
                    <Badge tone="neutral" className="font-mono">
                      {node.countryCode}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1.5 font-mono text-[10px]">
                  {node.tls && <Badge tone="success" className="border">TLS</Badge>}
                  {node.network && (
                    <Badge tone="neutral" className="border uppercase">
                      {node.network}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          ))}

          {filteredNodes.length === 0 && (
            <div className="col-span-full ui-panel p-12 rounded-2xl text-center text-xs text-ui-muted space-y-2">
              <Layers className="w-8 h-8 text-[#CCC6BB] mx-auto" />
              <p>暂无符合筛选条件的节点</p>
              <button
                onClick={onRefreshAll}
                className="px-3.5 py-1.5 text-xs font-semibold ui-button-primary rounded-xl"
              >
                立即从订阅源拉取
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Country Rule Modal */}
      <Modal
        open={!!(showCountryModal)}
        title={(showCountryModal) ? <>{editingCountryRule ? '编辑地区识别规则' : '添加国家/地区规则'}</> : ''}
        size="md"
        onClose={() => setShowCountryModal(false)}
      >
        {(showCountryModal) && (
          <ModalForm onSubmit={handleCountrySubmit}>
            <ModalBody>
              <div className="grid grid-cols-3 gap-2">
                <Field>
                  <Label className="block">国旗 Emoji</Label>
                  <Input
                    type="text"
                    required
                    placeholder="🇭🇰"
                    value={cEmoji}
                    onChange={e => setCEmoji(e.target.value)}
                    className="w-full"
                  />
                </Field>
                <Field>
                  <Label className="block">地区代码</Label>
                  <Input
                    type="text"
                    required
                    placeholder="HK"
                    value={cCode}
                    onChange={e => setCCode(e.target.value.toUpperCase())}
                    className="w-full font-mono"
                  />
                </Field>
                <Field>
                  <Label className="block">地区名称</Label>
                  <Input
                    type="text"
                    required
                    placeholder="香港"
                    value={cName}
                    onChange={e => setCName(e.target.value)}
                    className="w-full"
                  />
                </Field>
              </div>

              <Field>
                <Label className="block">匹配正则表达式 (不区分大小写)</Label>
                <Input
                  type="text"
                  required
                  placeholder=""
                  value={cPattern}
                  onChange={e => setCPattern(e.target.value)}
                  className="w-full font-mono"
                />
              </Field>

              <Field>
                <Label className="block">挂载对应测速分组 (可选)</Label>
                <Input
                  type="text"
                  placeholder=""
                  value={cGroupName}
                  onChange={e => setCGroupName(e.target.value)}
                  className="w-full"
                />
              </Field>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowCountryModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button type="submit" className="px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl">
                {editingCountryRule ? '保存修改' : '确认添加'}
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>

      {/* Extraction Rule Modal */}
      <Modal
        open={!!(showRuleModal)}
        title={(showRuleModal) ? <>{editingRule ? '编辑抽取规则' : '新建抽取规则'}</> : ''}
        size="lg"
        onClose={() => setShowRuleModal(false)}
      >
        {(showRuleModal) && (
          <ModalForm onSubmit={handleRuleSubmit}>
            <ModalBody>
              <Field>
                <Label className="block">规则名称</Label>
                <Input
                  type="text"
                  required
                  value={ruleName}
                  onChange={e => setRuleName(e.target.value)}
                  className="w-full"
                />
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field>
                  <Label className="block">包含正则 (Include)</Label>
                  <Input
                    type="text"
                    placeholder="如：(0\.5x|专线|BGP)"
                    value={includeRegex}
                    onChange={e => setIncludeRegex(e.target.value)}
                    className="w-full font-mono"
                  />
                </Field>
                <Field>
                  <Label className="block">排除正则 (Exclude)</Label>
                  <Input
                    type="text"
                    placeholder="如：(官网|到期|剩余|流量)"
                    value={excludeRegex}
                    onChange={e => setExcludeRegex(e.target.value)}
                    className="w-full font-mono"
                  />
                </Field>
              </div>

              <div className="p-3 bg-ui-subtle rounded-xl border border-ui-divider space-y-2">
                <span className="text-xs font-bold text-ui-text">节点重命名处理 (可选)</span>
                <div className="grid grid-cols-2 gap-2">
                  <Input aria-label="添加前缀 (如: [VIP] )"
                    type="text"
                    placeholder="添加前缀 (如: [VIP] )"
                    value={prefix}
                    onChange={e => setPrefix(e.target.value)}
                  />
                  <Input aria-label="添加后缀"
                    type="text"
                    placeholder="添加后缀"
                    value={suffix}
                    onChange={e => setSuffix(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Input aria-label="正则替换 (From)"
                    type="text"
                    placeholder="正则替换 (From)"
                    value={replaceFrom}
                    onChange={e => setReplaceFrom(e.target.value)}
                    className="font-mono"
                  />
                  <Input aria-label="替换为 (To)"
                    type="text"
                    placeholder="替换为 (To)"
                    value={replaceTo}
                    onChange={e => setReplaceTo(e.target.value)}
                    className="font-mono"
                  />
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowRuleModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button type="submit" className="px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl">
                {editingRule ? '保存修改' : '确认创建'}
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>
    </div>
  );
};
