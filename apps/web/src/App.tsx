import { Modal } from './components/Modal';
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Dashboard } from './components/Dashboard';
import { SourcesManager } from './components/SourcesManager';
import { NodesManager } from './components/NodesManager';
import { SourceRawModal } from './components/SourceRawModal';
import { GroupsManager } from './components/GroupsManager';
import { RulesManager } from './components/RulesManager';
import { TemplateEditor } from './components/TemplateEditor';
import { SettingsModal } from './components/SettingsModal';
import { LoginView } from './components/LoginView';
import {
  AppConfig,
  ProxyNode,
  SubscriptionSource,
  ExtractionRule,
  CountryPatternRule,
  ConfigTemplate,
  ProxyGroupItem,
  UnifiedRuleItem,
  SubscriptionProfile,
  GenerationPreviewResult,
} from './types';
import { readGenerationPreview } from './api';

const API_BASE = '/api';

export function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'sources' | 'nodes' | 'groups' | 'rules' | 'templates'>('dashboard');

  const [config, setConfig] = useState<AppConfig | null>(null);
  const [nodes, setNodes] = useState<ProxyNode[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [focusedSourceId, setFocusedSourceId] = useState<string | null>(null);
  const [rawSource, setRawSource] = useState<SubscriptionSource | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Authentication State
  const [authChecked, setAuthChecked] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

  // API helper that auto-injects auth header
  const apiFetch = async (url: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers || {});
    const token = localStorage.getItem('subone_auth_token');
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      setIsAuthenticated(false);
      setAuthRequired(true);
    }
    return res;
  };

  const checkAuth = async () => {
    try {
      const token = localStorage.getItem('subone_auth_token');
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${API_BASE}/auth/status`, { headers });
      if (res.ok) {
        const json = await res.json();
        setAuthRequired(json.authRequired);
        setIsAuthenticated(json.authenticated);
      } else {
        setIsAuthenticated(false);
      }
    } catch (e) {
      console.error('Auth check error:', e);
    } finally {
      setAuthChecked(true);
    }
  };

  const fetchConfigOnly = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/config`);
      if (res.ok) {
        const cJson = await res.json();
        setConfig(cJson.data);
      }
    } catch (e: any) {
      console.error('Failed to reload config:', e);
    }
  };

  const fetchData = async () => {
    try {
      const [configRes, nodesRes] = await Promise.all([
        apiFetch(`${API_BASE}/config`),
        apiFetch(`${API_BASE}/nodes`),
      ]);

      if (configRes.ok) {
        const cJson = await configRes.json();
        setConfig(cJson.data);
      }

      if (nodesRes.ok) {
        const nJson = await nodesRes.json();
        setNodes(nJson.data || []);
      }
    } catch (e: any) {
      console.error('Failed to load initial data:', e);
      setErrorMsg('无法连接后端服务，请确认服务已启动');
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (authChecked && (isAuthenticated || !authRequired)) {
      fetchData();
    }
  }, [authChecked, isAuthenticated, authRequired]);

  const handleLoginSuccess = (token: string) => {
    localStorage.setItem('subone_auth_token', token);
    setIsAuthenticated(true);
    fetchData();
  };

  const handleLogout = async () => {
    try {
      await apiFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    } finally {
      localStorage.removeItem('subone_auth_token');
      setIsAuthenticated(false);
    }
  };

  const handleChangePassword = async (oldPassword: string, newPassword: string): Promise<boolean> => {
    const res = await apiFetch(`${API_BASE}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    if (res.ok) {
      await fetchData();
      return true;
    }
    return false;
  };

  const handleUpdateSettings = async (settings: Partial<AppConfig['settings']>): Promise<boolean> => {
    const res = await apiFetch(`${API_BASE}/config/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    if (res.ok) {
      await fetchData();
      return true;
    }
    return false;
  };

  const handleRegenerateSubToken = async (): Promise<string | null> => {
    const res = await apiFetch(`${API_BASE}/settings/regenerate-sub-token`, { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      await fetchData();
      return json.subToken;
    }
    return null;
  };

  const handleUpdateNode = async (id: string, updates: { name?: string; enabled?: boolean }) => {
    const res = await apiFetch(`${API_BASE}/nodes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || '保存本地设置失败');
    }
    await fetchData();
  };

  const handleRefreshAllSources = async () => {
    setErrorMsg(null);
    const res = await apiFetch(`${API_BASE}/sources/refresh-all`, { method: 'POST' });
    const json = await res.json().catch(() => null);
    await fetchData();
    if (!res.ok) throw new Error(json?.message || '批量上游更新失败');
    const failures = (json?.results || []).filter((result: { success: boolean }) => !result.success);
    if (failures.length) throw new Error(`${failures.length} 个上游更新失败`);
    if (json?.success === false) throw new Error(json?.message || '批量上游更新失败');
  };

  // Sources handlers
  const handleAddSource = async (source: { name: string; url?: string; acquisition?: 'url' | 'manual'; content?: string; type: string; trafficNodeRegex?: string; expiryNodeRegex?: string }) => {
    setErrorMsg(null);
    const res = await apiFetch(`${API_BASE}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || `添加订阅失败 (HTTP ${res.status})`);
    }
    await fetchData();
  };

  const handleUpdateSource = async (id: string, updates: Partial<SubscriptionSource>) => {
    const res = await apiFetch(`${API_BASE}/sources/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const json = await res.json().catch(() => null);
    await fetchData();
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || '保存订阅失败');
    }
  };

  const handleDeleteSource = async (id: string) => {
    const res = await apiFetch(`${API_BASE}/sources/${id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || '删除失败，请重试');
    }
    await fetchData();
  };

  const handleRefreshSource = async (id: string) => {
    setErrorMsg(null);
    const res = await apiFetch(`${API_BASE}/sources/${id}/refresh`, { method: 'POST' });
    const json = await res.json().catch(() => null);
    await fetchData();
    if (!res.ok || json?.success === false) {
      throw new Error(json?.message || '上游更新失败');
    }
  };

  // Publish group changes only after the API acknowledges persistence.
  const handleAddGroup = async (group: Partial<ProxyGroupItem>) => {
    const res = await apiFetch(`${API_BASE}/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(group),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) throw new Error(json?.message || '新建策略组失败');
    if (json?.data) setConfig(prev => prev ? { ...prev, proxyGroups: [...(prev.proxyGroups || []), json.data] } : prev);
    else await fetchConfigOnly();
  };

  const handleBatchImportGroups = async (text: string, replaceAll?: boolean) => {
    const res = await apiFetch(`${API_BASE}/groups/batch-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, replaceAll }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) throw new Error(json?.message || '替换策略组失败');
    if (json?.data) setConfig(prev => prev ? { ...prev, proxyGroups: json.data } : prev);
    else await fetchConfigOnly();
  };

  const handleUpdateGroup = async (id: string, updates: Partial<ProxyGroupItem>) => {
    const res = await apiFetch(`${API_BASE}/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) throw new Error(json?.message || '保存策略组失败');
    if (json?.data) setConfig(prev => prev ? { ...prev, proxyGroups: (prev.proxyGroups || []).map(group => group.id === id ? json.data : group) } : prev);
    await fetchConfigOnly();
  };

  const handleDeleteGroup = async (id: string) => {
    const res = await apiFetch(`${API_BASE}/groups/${id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.success === false) throw new Error(json?.message || '删除策略组失败');
    setConfig(prev => prev ? { ...prev, proxyGroups: (prev.proxyGroups || []).filter(group => group.id !== id) } : prev);
    await fetchConfigOnly();
  };

  // Unified Rules handlers
  const handleAddRule = async (rule: Partial<UnifiedRuleItem>) => {
    const res = await apiFetch(`${API_BASE}/rules/unified`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.data) {
        setConfig(prev => prev ? { ...prev, rulesList: [...(prev.rulesList || []), json.data] } : prev);
      } else {
        await fetchConfigOnly();
      }
    }
  };

  const handleImportLocalRules = async (text: string, defaultOutbound?: string) => {
    const res = await apiFetch(`${API_BASE}/rules/import-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, defaultOutbound }),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.data) {
        setConfig(prev => prev ? { ...prev, rulesList: json.data } : prev);
      } else {
        await fetchConfigOnly();
      }
    }
  };

  const handleImportRemoteRules = async (text: string, defaultOutbound?: string) => {
    const res = await apiFetch(`${API_BASE}/rules/import-remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, defaultOutbound }),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.data) {
        setConfig(prev => prev ? { ...prev, rulesList: json.data } : prev);
      } else {
        await fetchConfigOnly();
      }
    }
  };

  const handleBatchReplaceRules = async (text: string, defaultOutbound?: string) => {
    const res = await apiFetch(`${API_BASE}/rules/unified/batch-replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, defaultOutbound }),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.data) {
        setConfig(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            rulesList: json.data,
            proxyGroups: json.groups || prev.proxyGroups,
          };
        });
      } else {
        await fetchConfigOnly();
      }
    }
  };

  const handleUpdateRule = async (id: string, updates: Partial<UnifiedRuleItem>) => {
    // Optimistic update for instant UI feedback
    setConfig(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        rulesList: (prev.rulesList || []).map(r => r.id === id ? { ...r, ...updates } : r),
      };
    });

    try {
      const res = await apiFetch(`${API_BASE}/rules/unified/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json?.data) {
          setConfig(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              rulesList: (prev.rulesList || []).map(r => r.id === id ? json.data : r),
            };
          });
        }
      } else {
        await fetchConfigOnly();
      }
    } catch (err) {
      console.error('Failed to update rule:', err);
      await fetchConfigOnly();
    }
  };

  const handleDeleteRule = async (id: string) => {
    setConfig(prev => prev ? {
      ...prev,
      rulesList: (prev.rulesList || []).filter(r => r.id !== id),
    } : prev);

    const res = await apiFetch(`${API_BASE}/rules/unified/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      await fetchConfigOnly();
    }
  };

  const handleClearAllRules = async () => {
    setConfig(prev => prev ? { ...prev, rulesList: [] } : prev);
    const res = await apiFetch(`${API_BASE}/rules/unified/clear-all`, { method: 'POST' });
    if (!res.ok) {
      await fetchConfigOnly();
    }
  };

  const handleResetDefaultRules = async () => {
    const res = await apiFetch(`${API_BASE}/rules/unified/reset`, { method: 'POST' });
    if (res.ok) {
      const json = await res.json();
      if (json.data) {
        setConfig(prev => prev ? { ...prev, rulesList: json.data } : prev);
      }
    } else {
      await fetchConfigOnly();
    }
  };

  // Templates handlers

  const handleAddTemplate = async (template: Partial<ConfigTemplate>): Promise<ConfigTemplate | undefined> => {
    const res = await apiFetch(`${API_BASE}/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data?.data) {
        setConfig(prev => prev ? { ...prev, templates: [...(prev.templates || []), data.data] } : prev);
        return data.data;
      }
      await fetchConfigOnly();
    }
    return undefined;
  };

  const handleUpdateTemplate = async (id: string, updates: Partial<ConfigTemplate>) => {
    setConfig(prev => prev ? {
      ...prev,
      templates: (prev.templates || []).map(t => t.id === id ? { ...t, ...updates } : t),
    } : prev);

    const res = await apiFetch(`${API_BASE}/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json?.data) {
        setConfig(prev => prev ? {
          ...prev,
          templates: (prev.templates || []).map(t => t.id === id ? json.data : t),
        } : prev);
      }
    } else {
      await fetchConfigOnly();
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    setConfig(prev => prev ? {
      ...prev,
      templates: (prev.templates || []).filter(t => t.id !== id),
    } : prev);

    const res = await apiFetch(`${API_BASE}/templates/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      await fetchConfigOnly();
    }
  };

  const handleResetTemplate = async (id: string): Promise<ConfigTemplate> => {
    const res = await apiFetch(`${API_BASE}/templates/${id}/reset`, { method: 'POST' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      throw new Error(json.message || json.error || '恢复默认模版失败');
    }
    if (json.data) {
      setConfig(prev => prev ? {
        ...prev,
        templates: (prev.templates || []).map(t => t.id === id ? json.data : t),
      } : prev);
    }
    return json.data;
  };

  const handlePreview = async (templateId?: string, customTemplate?: string, customType?: string): Promise<GenerationPreviewResult> => {
    const res = await apiFetch(`${API_BASE}/generate/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, customTemplate, customType }),
    });
    return readGenerationPreview(res);
  };

  // Settings handlers
  const handleSaveSettings = async (settings: { subToken?: string }) => {
    const res = await apiFetch(`${API_BASE}/config/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    if (res.ok) await fetchData();
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-ui-subtle flex items-center justify-center">
        <div className="text-xs text-ui-muted font-mono animate-pulse">正在初始化安全环境...</div>
      </div>
    );
  }

  if (authRequired && !isAuthenticated) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  const handleUpdateProfiles = (updater: (prevProfiles: SubscriptionProfile[]) => SubscriptionProfile[]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        profiles: updater(prev.profiles || []),
      };
    });
  };

  return (
    <div className="min-h-screen bg-ui-subtle text-ui-text flex flex-col selection:bg-[#E8D7C7] selection:text-ui-text">
      <Header
        activeTab={activeTab}
        setActiveTab={tab => { setFocusedSourceId(null); setActiveTab(tab); }}
        onOpenSettings={() => setShowSettings(true)}
        nodeCount={nodes.length}
        hasAuth={authRequired}
        onLogout={handleLogout}
      />

      {errorMsg && (
        <div className="bg-[#FDF2F0] border-b border-[#F2D6D3] text-[#A8483B] text-xs px-6 py-2 text-center">
          {errorMsg}
        </div>
      )}

      <main className="flex-1 p-4 pb-24 sm:p-6 md:pb-6">
        {activeTab === 'dashboard' && (
          <Dashboard
            config={config}
            nodes={nodes}
            onNavigateTab={setActiveTab}
            onRefreshConfig={fetchData}
            onUpdateProfiles={handleUpdateProfiles}
          />
        )}

        {activeTab === 'sources' && (
          <SourcesManager
            sources={config?.sources || []}
            onAddSource={handleAddSource}
            onUpdateSource={handleUpdateSource}
            onDeleteSource={handleDeleteSource}
            onRefreshSource={handleRefreshSource}
            onRefreshAllSources={handleRefreshAllSources}
            onOpenNodes={sourceId => { setFocusedSourceId(sourceId); setActiveTab('nodes'); }}
            onViewRaw={setRawSource}
          />
        )}


        {activeTab === 'nodes' && <NodesManager
          key={focusedSourceId || 'nodes'}
          sources={config?.sources || []}
          focusSourceId={focusedSourceId}
          onUpdateNode={handleUpdateNode}
          onRefreshSource={handleRefreshSource}
        />}

        {activeTab === 'groups' && config && (
          <GroupsManager
            groups={config.proxyGroups || []}
            sources={config.sources || []}
            nodes={nodes}
            sourceIcons={config.settings?.sourceIcons}
            onAddGroup={handleAddGroup}
            onUpdateGroup={handleUpdateGroup}
            onDeleteGroup={handleDeleteGroup}
            onBatchImportGroups={handleBatchImportGroups}
          />
        )}

        {activeTab === 'rules' && config && (
          <RulesManager
            proxyGroups={config.proxyGroups || []}
            rulesList={config.rulesList || []}
            templates={config.templates || []}
            onAddRule={handleAddRule}
            onImportLocalRules={handleImportLocalRules}
            onImportRemoteRules={handleImportRemoteRules}
            onBatchReplaceRules={handleBatchReplaceRules}
            onUpdateRule={handleUpdateRule}
            onDeleteRule={handleDeleteRule}
            onClearAllRules={handleClearAllRules}
            onResetDefaultRules={handleResetDefaultRules}
          />
        )}

        {activeTab === 'templates' && config && (
          <TemplateEditor
            templates={config.templates || []}
            onAddTemplate={handleAddTemplate}
            onUpdateTemplate={handleUpdateTemplate}
            onDeleteTemplate={handleDeleteTemplate}
            onResetTemplate={handleResetTemplate}
            onPreview={handlePreview}
          />
        )}

      </main>

      <SourceRawModal source={rawSource} onClose={() => setRawSource(null)} />

      <Modal
        open={showSettings && !!config}
        title="全局偏好与设置"
        size="lg"
        onClose={() => setShowSettings(false)}
      >
        {config && (
          <SettingsModal
            config={config}
            onChangePassword={handleChangePassword}
            onUpdateSettings={handleUpdateSettings}
          />
        )}
      </Modal>
    </div>
  );
}

export default App;

