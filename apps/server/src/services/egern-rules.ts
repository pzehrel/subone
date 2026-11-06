import { egernRuleSource, convertEgernRules } from '../core/generators/egern-ruleset';
import type { UnifiedRuleItem } from '../types';

const cache = new Map<string, { output: string; expires: number }>();
export async function getEgernRules(rule: UnifiedRuleItem): Promise<string> {
  const source = egernRuleSource(rule);
  if (!source) throw new Error('Unsupported rule source');
  const key = JSON.stringify(source); const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.output;
  const response = await fetch(source.url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Rule upstream unavailable');
  const text = await response.text(); if (text.length > 16 * 1024 * 1024) throw new Error('Rule set too large');
  const output = convertEgernRules(text, source);
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { output, expires: Date.now() + 30 * 60 * 1000 });
  return output;
}
