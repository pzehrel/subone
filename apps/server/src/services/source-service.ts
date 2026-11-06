import { getAppConfig, setAppConfig, setGlobalNodesCache } from '../context';
import { fetchAndParseSource, SourceParseError } from '../core/parser/fetcher';
import { cleanSourceOrGroupName } from '../core/generators/common';
import { saveConfig } from '../storage/db';
import type { AppConfig, SubscriptionSource } from '../types';
import { prepareSourceNodes } from './node-identity';
import { bindSourceDoh } from '../core/parser/source-doh';
import { collectNodesFromSources } from './profile-service';

/** Publish only after the complete application candidate has been durably saved. */
export function commitConfig(candidate: AppConfig): void {
  saveConfig(candidate);
  setAppConfig(candidate);
  setGlobalNodesCache(collectNodesFromSources(candidate));
}

export function commitSource(candidate: SubscriptionSource): void {
  const config = structuredClone(getAppConfig());
  const index = config.sources.findIndex(source => source.id === candidate.id);
  if (index < 0) throw new Error('Source not found');
  const oldName = cleanSourceOrGroupName(config.sources[index].name).toLowerCase();
  if (candidate.name !== config.sources[index].name) {
    for (const group of config.proxyGroups) {
      for (const field of ['sources', 'use'] as const) {
        group[field] = group[field]?.map(value => cleanSourceOrGroupName(value).toLowerCase() === oldName ? candidate.name : value);
      }
    }
  }
  config.sources[index] = candidate;
  commitConfig(config);
}

export class SourceUpdateError extends Error {
  constructor(message: string, public status: 422 | 500 = 422) { super(message); }
}

export async function refreshSource(id: string, changes: Partial<SubscriptionSource> = {}): Promise<SubscriptionSource> {
  const current = getAppConfig().sources.find(source => source.id === id);
  if (!current) throw new Error('Source not found');
  const candidate = { ...structuredClone(current), ...changes };
  try {
    candidate.nodes = await fetchAndParseSource(candidate, getAppConfig().countryRules);
    candidate.nodeCount = candidate.nodes.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : '上游更新失败';
    const latest = getAppConfig().sources.find(source => source.id === id);
    if (!latest) throw new SourceUpdateError(message, error instanceof SourceParseError ? 422 : 500);
    const diagnostic = structuredClone(latest);
    diagnostic.lastUpdateError = message;
    if (error instanceof SourceParseError) {
      diagnostic.rawSubscription = { content: error.content, fetchedAt: error.fetchedAt, contentType: error.contentType, format: error.format, parseStatus: 'failed', error: message };
    }
    try { commitSource(diagnostic); } catch (saveError) {
      throw new SourceUpdateError(saveError instanceof Error ? saveError.message : '保存失败', 500);
    }
    throw new SourceUpdateError(message, error instanceof SourceParseError ? 422 : 500);
  }
  prepareSourceNodes(candidate, getAppConfig().sources.find(source => source.id === id));
  bindSourceDoh(candidate);
  try { commitSource(candidate); } catch (error) {
    throw new SourceUpdateError(error instanceof Error ? error.message : '保存失败', 500);
  }
  return candidate;
}
