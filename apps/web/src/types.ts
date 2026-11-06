import type { SubscriptionInfo } from '../../../shared/subscription-info';
export type { SubscriptionInfo } from '../../../shared/subscription-info';

export interface ProxyNode {
  id: string;
  name: string;
  originalName?: string;
  enabled?: boolean;
  type: string;
  server: string;
  port: number;
  sourceId?: string;
  sourceName?: string;
  countryCode?: string;
  countryEmoji?: string;
  network?: string;
  tls?: boolean;
  detour?: string;
  raw?: string;
  [key: string]: any;
}

export interface SourceFilterConfig {
  parentSourceIds?: string[]; // 选中的节点来源，为空代表全部来源
  includeRegex?: string;      // 包含正则/关键词
  excludeRegex?: string;      // 排除正则/关键词
}

export type SourceFormat = 'mihomo' | 'singbox' | 'quantumultx' | 'uri' | 'base64';
export interface SourceRawRecord {
  content: string;
  fetchedAt: string;
  contentType?: string;
  format?: SourceFormat;
  parseStatus: 'success' | 'failed';
  error?: string;
  lastSuccessfulUpdate?: string;
}

export interface SubscriptionSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  type?: 'remote' | 'manual' | 'auto' | 'base64' | 'clash' | 'singbox' | 'quantumultx' | 'custom' | string;
  lastUpdated?: string;
  detectedFormat?: SourceFormat;
  lastUpdateError?: string;
  nodeCount?: number;
  nodes?: ProxyNode[];
  trafficNodeRegex?: string;
  expiryNodeRegex?: string;
  infoNodes?: ProxyNode[];
  subscriptionInfo?: SubscriptionInfo;
}

export interface ExtractionRule {
  id: string;
  name: string;
  enabled: boolean;
  sourceIds?: string[];
  includeRegex?: string;
  excludeRegex?: string;
  includeKeywords?: string[];
  excludeKeywords?: string[];
  targetCountries?: string[];
  renamePattern?: {
    prefix?: string;
    suffix?: string;
    replaceFrom?: string;
    replaceTo?: string;
  };
}

export type ClientType = 'singbox' | 'mihomo' | 'loon' | 'quantumultx' | 'egern' | 'shadowrocket';

export interface GenerationDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  sourceId?: string;
  serviceId?: string;
}

export interface GenerationBinding {
  sourceId: string;
  sourceName: string;
  batchId?: string;
  updatedAt?: string;
  nodeIds: string[];
  services: { id: string; url: string }[];
  status: 'applied' | 'degraded' | 'unapplied' | 'template' | 'ignored';
  method: string;
  appliedServiceIds: string[];
  diagnostics: GenerationDiagnostic[];
}

export interface GenerationMetadata {
  target: { type: ClientType; version?: string; mode: 'complete' | 'nodes' };
  nodeCount: number;
  dependencyNodeCount: number;
  bindings: GenerationBinding[];
  diagnostics: GenerationDiagnostic[];
}

export interface GenerationPreviewResult {
  success: boolean;
  nodeCount: number;
  data: string;
  message?: string;
  generation?: GenerationMetadata;
}

export interface ConfigTemplate {
  id: string;
  name: string;
  type: ClientType;
  content: string;
  isDefault?: boolean;
  description?: string;
}

export interface ProxyGroupItem {
  id: string;
  name: string;
  type: 'select' | 'urltest' | 'fallback' | 'load-balance' | 'relay' | 'direct' | 'reject';
  proxies?: string[];
  sources?: string[];
  use?: string[];
  filter?: string;
  tolerance?: number;
  url?: string;
  interval?: number;
  isCountryGroup?: boolean;
  icon?: string;
}


export type RuleType =
  | 'DOMAIN-SUFFIX'
  | 'DOMAIN-KEYWORD'
  | 'DOMAIN'
  | 'IP-CIDR'
  | 'SRC-IP-CIDR'
  | 'GEOIP'
  | 'RULE-SET'
  | 'FINAL'
  | 'OTHER';

export interface UnifiedRuleItem {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  type: RuleType;
  payload: string;
  format?: 'binary' | 'mrs' | 'yaml' | 'text';
  outbound: string;
  enabled: boolean;
  clientUrls?: {
    singbox?: string;
    mihomo?: string;
    loon?: string;
    quantumultx?: string;
    egern?: string;
    shadowrocket?: string;
  };
}

export interface CountryPatternRule {
  id: string;
  code: string;
  name: string;
  emoji: string;
  pattern: string;
  groupName?: string;
}

export interface ProfileNodeFilter {
  mode?: 'all' | 'filter' | 'manual';
  sourceIds?: string[];
  countryCodes?: string[];
  includeKeywords?: string[];
  excludeKeywords?: string[];
  includeRegex?: string;
  excludeRegex?: string;
  selectedNodeIds?: string[];
}

export interface SubscriptionProfile {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  description?: string;
  nodeFilter: ProfileNodeFilter;
  selectedGroupIds?: string[];
  selectedRuleIds?: string[];
  templates?: {
    mihomo?: string;
    singbox?: string;
    loon?: string;
    quantumultx?: string;
    egern?: string;
    shadowrocket?: string;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface SourceIconsConfig {
  custom?: string;
  filter?: string;
  remote?: string;
}

export interface AppConfig {
  sources: SubscriptionSource[];
  rules: ExtractionRule[];
  countryRules?: CountryPatternRule[];
  templates: ConfigTemplate[];
  proxyGroups: ProxyGroupItem[];
  rulesList: UnifiedRuleItem[];
  profiles: SubscriptionProfile[];
  settings: {
    token?: string;
    subToken?: string;
    adminPassword?: string;
    port?: number;
    sourceIcons?: SourceIconsConfig;
  };
}


