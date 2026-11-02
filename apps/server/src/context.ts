import type { HonoRequest } from 'hono';
import { AppConfig, ProxyNode } from './types/index';
import { loadConfig, saveConfig } from './storage/db';

export let appConfig: AppConfig = loadConfig();
let globalNodesCache: ProxyNode[] = [];

export function getAppConfig(): AppConfig {
  return appConfig;
}

export function setAppConfig(config: AppConfig): void {
  appConfig = config;
}

export function saveAppConfig(): void {
  saveConfig(appConfig);
}

export function getGlobalNodesCache(): ProxyNode[] {
  return globalNodesCache;
}

export function setGlobalNodesCache(nodes: ProxyNode[]): void {
  globalNodesCache = nodes;
}

export function getBaseUrl(req: HonoRequest): string {
  const port = process.env.PORT || appConfig.settings?.port || 3456;
  const proto = req.header('x-forwarded-proto') || new URL(req.url).protocol.slice(0, -1) || 'http';
  const host = req.header('x-forwarded-host') || req.header('host') || `localhost:${port}`;
  return `${proto}://${host}`;
}
