import React from 'react';
import {
  Layers,
  Settings,
  LogOut,
  LayoutDashboard,
  FileCode,
  BookOpen,
} from 'lucide-react';
import { SourcesIcon, GroupsIcon, RulesIcon } from './ui/module-icons';

interface HeaderProps {
  activeTab: 'dashboard' | 'sources' | 'groups' | 'rules' | 'templates';
  setActiveTab: (tab: 'dashboard' | 'sources' | 'groups' | 'rules' | 'templates') => void;
  onOpenSettings: () => void;
  nodeCount: number;
  hasAuth?: boolean;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  onOpenSettings,
  nodeCount,
  hasAuth,
  onLogout,
}) => {
  const tabs = [
    { id: 'dashboard', label: '首页', shortLabel: '首页', icon: LayoutDashboard },
    { id: 'sources', label: '上游订阅', shortLabel: '上游订阅', icon: SourcesIcon },
    { id: 'groups', label: '策略组', shortLabel: '策略组', icon: GroupsIcon },
    { id: 'rules', label: '分流规则', shortLabel: '分流规则', icon: RulesIcon },
    { id: 'templates', label: '配置模版', shortLabel: '配置模版', icon: FileCode },
  ] as const;

  return (
    <>
      {/* Top Header Bar */}
      <header className="sticky top-0 z-30 bg-ui-subtle/85 backdrop-blur-md border-b border-ui-border/80 px-4 sm:px-8 py-2.5 flex items-center justify-between">
        {/* Brand logo */}
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2.5 cursor-pointer group"
            onClick={() => setActiveTab('dashboard')}
          >
            <div className="w-7 h-7 rounded-lg bg-ui-accent flex items-center justify-center text-white shadow-sm transition-transform group-hover:scale-105">
              <Layers className="w-4 h-4 stroke-[2.2]" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-ui-text">
              sub<span className="text-ui-accent font-normal">one</span>
            </span>
          </div>
        </div>

        {/* Desktop Tabs navigation (hidden on mobile, visible on md and up) */}
        <nav className="hidden md:flex items-center gap-1">
          {tabs.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors duration-150 cursor-pointer ${isActive
                    ? 'text-ui-accent font-semibold bg-ui-accent/10'
                    : 'text-ui-secondary hover:text-ui-text hover:bg-ui-hover/60'
                  }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Right actions */}
        <div className="flex items-center gap-1.5">
          <a
            href="https://cfm019.github.io/subone-doc/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-ui-secondary hover:text-ui-text hover:bg-ui-hover rounded-lg transition-colors cursor-pointer"
            title="查看在线使用说明与配置手册"
            aria-label="查看在线文档"
          >
            <BookOpen className="w-4 h-4 text-ui-accent" />
            <span className="hidden sm:inline">文档</span>
          </a>

          <button
            onClick={onOpenSettings}
            className="p-1.5 text-ui-secondary hover:text-ui-text hover:bg-ui-hover rounded-lg transition-colors cursor-pointer"
            title="设置与安全"
            aria-label="设置与安全"
          >
            <Settings className="w-4 h-4" />
          </button>

          {hasAuth && onLogout && (
            <button
              onClick={onLogout}
              className="p-1.5 text-ui-secondary hover:text-[#A8483B] hover:bg-[#FDF2F0] rounded-lg transition-colors cursor-pointer"
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar (visible on mobile < md, fixed at bottom) */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-ui-subtle/92 backdrop-blur-md border-t border-ui-border/80 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-lg shadow-black/5 flex items-center justify-around"
        aria-label="移动端底部导航"
      >
        {tabs.map(tab => {
          const isActive = activeTab === tab.id;
          const IconComponent = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-all duration-150 cursor-pointer ${isActive
                  ? 'text-ui-accent'
                  : 'text-[#7D7971] hover:text-ui-text'
                }`}
            >
              <div
                className={`relative flex items-center justify-center w-8 h-6 rounded-full transition-colors ${isActive ? 'bg-ui-accent/15' : ''
                  }`}
              >
                <IconComponent
                  className={`w-4 h-4 transition-transform duration-150 ${isActive ? 'scale-110 stroke-[2.4]' : 'stroke-[1.8]'
                    }`}
                />
              </div>
              <span
                className={`text-[10px] leading-tight tracking-tight mt-0.5 whitespace-nowrap ${isActive ? 'font-semibold text-ui-accent' : 'font-normal'
                  }`}
              >
                {tab.shortLabel}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
};

