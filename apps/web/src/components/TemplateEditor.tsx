import { Modal, ModalBody, ModalFooter, ModalForm } from './Modal';
import React, { useState, useEffect } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  FileCode,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';
import { ConfigTemplate, ClientType } from '../types';

interface TemplateEditorProps {
  templates: ConfigTemplate[];
  onAddTemplate: (template: Partial<ConfigTemplate>) => Promise<ConfigTemplate | undefined>;
  onUpdateTemplate: (id: string, updates: Partial<ConfigTemplate>) => Promise<void>;
  onDeleteTemplate: (id: string) => Promise<void>;
  onResetTemplate: (id: string) => Promise<ConfigTemplate>;
  onPreview?: (templateId?: string, customTemplate?: string, customType?: string) => Promise<{ nodeCount: number; data: string }>;
}

export const TemplateEditor: React.FC<TemplateEditorProps> = ({
  templates,
  onAddTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  onResetTemplate,
}) => {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(templates[0]?.id || '');
  const [templateContent, setTemplateContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // New Template Modal state
  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ClientType>('singbox');
  const [newDesc, setNewDesc] = useState('');

  const currentTemplate = templates.find(t => t.id === selectedTemplateId) || templates[0];

  useEffect(() => {
    if (currentTemplate) {
      setTemplateContent(currentTemplate.content || '');
    }
  }, [selectedTemplateId, currentTemplate]);

  const handleResetTemplate = async () => {
    if (!currentTemplate) return;
    if (!window.confirm(`确定要将当前模版「${currentTemplate.name}」恢复为系统内置的默认配置吗？`)) return;
    setIsSaving(true);
    try {
      const resetTpl = await onResetTemplate(currentTemplate.id);
      if (resetTpl?.content) {
        setTemplateContent(resetTpl.content);
      }
    } catch (err: any) {
      console.error('handleResetTemplate error:', err);
      alert(err.message || '重置失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!currentTemplate) return;
    setIsSaving(true);
    try {
      await onUpdateTemplate(currentTemplate.id, { content: templateContent });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const created = await onAddTemplate({
      name: newName.trim(),
      type: newType,
      description: newDesc.trim() || undefined,
    });
    setNewName('');
    setNewDesc('');
    setShowNewModal(false);
    if (created?.id) {
      setSelectedTemplateId(created.id);
    }
  };

  const handleCopyTemplate = () => {
    navigator.clipboard.writeText(templateContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadTemplate = () => {
    if (!currentTemplate) return;
    const ext = currentTemplate.type === 'singbox'
      ? 'json'
      : (currentTemplate.type === 'mihomo' || currentTemplate.type === 'egern' ? 'yaml' : 'conf');
    const blob = new Blob([templateContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentTemplate.name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getTypeBadge = (type: string) => {
    switch (type) {
      case 'singbox':
        return { label: 'Sing-box', color: 'bg-[#EFF6F4] text-[#367A68] border-[#D1E5DF]' };
      case 'mihomo':
        return { label: 'Mihomo (Clash)', color: 'bg-[#FAF0E6] text-[#B85D38] border-[#E8D7C7]' };
      case 'loon':
        return { label: 'Loon', color: 'bg-[#F2F0F7] text-[#635588] border-[#DDD8EB]' };
      case 'quantumultx':
        return { label: 'Quantumult X', color: 'bg-[#FDF4E7] text-[#C06014] border-[#F6DCBF]' };
      case 'egern':
        return { label: 'Egern', color: 'bg-[#EFF6FF] text-[#1D4ED8] border-[#BFDBFE]' };
      case 'shadowrocket':
        return { label: 'Shadowrocket', color: 'bg-[#F0FDF4] text-[#15803D] border-[#BBF7D0]' };
      default:
        return { label: type, color: 'bg-[#F3F4F6] text-[#4B5563] border-[#E5E7EB]' };
    }
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto h-[calc(100vh-130px)] flex flex-col min-h-0">
      {/* Control bar */}
      <div className="ui-panel p-3.5 rounded-2xl flex flex-wrap items-center justify-between gap-3 shrink-0">
        {/* Dropdown template selector */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <select
              value={selectedTemplateId}
              onChange={e => setSelectedTemplateId(e.target.value)}
              className="appearance-none pl-3.5 pr-9 py-2 bg-ui-surface border border-ui-border rounded-xl text-xs font-semibold text-ui-text focus:outline-none focus:border-ui-accent shadow-xs cursor-pointer"
            >
              {templates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.isDefault ? '⭐' : ''}
                </option>
              ))}
            </select>
            <ChevronDown className="w-4 h-4 text-ui-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-1 px-3 py-2 text-xs font-semibold ui-button-secondary rounded-xl shadow-xs"
          >
            <Plus className="w-3.5 h-3.5 text-ui-accent" />
            <span>新建模版</span>
          </button>

          {currentTemplate && (
            <div className="hidden sm:flex items-center gap-2">
              <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-md border ${getTypeBadge(currentTemplate.type).color}`}>
                {getTypeBadge(currentTemplate.type).label}
              </span>
              {!currentTemplate.isDefault && (
                <button
                  onClick={() => onUpdateTemplate(currentTemplate.id, { isDefault: true })}
                  className="text-[11px] text-ui-secondary hover:text-ui-text hover:underline"
                >
                  设为此格式默认
                </button>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {templates.length > 1 && currentTemplate && (
            <button
              onClick={() => onDeleteTemplate(currentTemplate.id)}
              className="p-2 text-[#A8483B] hover:bg-[#FDF2F0] rounded-xl border border-transparent hover:border-[#F2D6D3]"
              title="删除当前模版"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={handleResetTemplate}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold ui-button-secondary rounded-xl text-ui-secondary hover:text-ui-text"
            title="恢复为系统内置的默认模版"
          >
            <RotateCcw className="w-3.5 h-3.5 text-ui-accent" />
            <span>恢复默认</span>
          </button>

          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl shadow-xs"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{isSaving ? '保存中...' : '保存模版'}</span>
          </button>
        </div>
      </div>

      {/* Editor Full Width Pane */}
      <div className="flex-1 flex flex-col min-h-0 h-full">
        <div className="ui-panel rounded-2xl flex flex-col h-full min-h-0 overflow-hidden shadow-xs">
          <div className="px-4 py-2.5 bg-ui-subtle border-b border-ui-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-ui-accent" />
              <span className="text-xs font-bold text-ui-text">模版配置骨架</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleCopyTemplate}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium ui-button-secondary rounded-lg"
                title="复制模版内容"
              >
                {copied ? <Check className="w-3 h-3 text-[#367A68]" /> : <Copy className="w-3 h-3 text-ui-secondary" />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
              <button
                onClick={handleDownloadTemplate}
                className="p-1 text-ui-secondary hover:text-ui-text ui-button-secondary rounded-lg"
                title="下载模版文件"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="flex-1 relative min-h-0 w-full h-full bg-ui-surface">
            <textarea
              value={templateContent}
              onChange={e => setTemplateContent(e.target.value)}
              spellCheck={false}
              className="absolute inset-0 w-full h-full p-4 bg-ui-surface font-mono text-xs text-ui-text focus:outline-none resize-none leading-relaxed overflow-y-auto overflow-x-auto"
              placeholder="此处编辑配置模版..."
            />
          </div>
        </div>
      </div>

      {/* New Template Modal */}
      <Modal
        open={!!(showNewModal)}
        title={(showNewModal) ? <>新建配置模版</> : ''}
        size="md"
        onClose={() => setShowNewModal(false)}
      >
        {(showNewModal) && (
          <ModalForm onSubmit={handleCreateSubmit}>
            <ModalBody>
              <div>
                <label className="block text-xs font-medium text-ui-secondary mb-1.5">模版名称</label>
                <input
                  type="text"
                  required
                  placeholder=""
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  className="w-full px-3.5 py-2 ui-input rounded-xl text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ui-secondary mb-1.5">目标客户端格式</label>
                <select
                  value={newType}
                  onChange={e => setNewType(e.target.value as any)}
                  className="w-full px-3.5 py-2 ui-input rounded-xl text-xs"
                >
                  <option value="singbox">Sing-box (JSON 格式)</option>
                  <option value="mihomo">Mihomo / ShellCrash (YAML 格式)</option>
                  <option value="loon">Loon (MCF 格式)</option>
                  <option value="quantumultx">Quantumult X (CONF 格式)</option>
                  <option value="egern">Egern (YAML 格式)</option>
                  <option value="shadowrocket">Shadowrocket (CONF 格式)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-ui-secondary mb-1.5">模版备注描述 (可选)</label>
                <input
                  type="text"
                  placeholder=""
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  className="w-full px-3.5 py-2 ui-input rounded-xl text-xs"
                />
              </div>
            </ModalBody>
            <ModalFooter>
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="px-4 py-2 text-xs font-medium ui-button-secondary rounded-xl"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold ui-button-primary rounded-xl"
              >
                确认创建
              </button>
            </ModalFooter>
          </ModalForm>
        )}
      </Modal>
    </div>
  );
};
