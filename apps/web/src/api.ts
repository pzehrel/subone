import type { GenerationPreviewResult, SourceRawRecord } from './types';

export const API_BASE = '/api';

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem('subone_auth_token');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...options, headers });
}

export async function getSourceRaw(sourceId: string, signal?: AbortSignal): Promise<SourceRawRecord> {
  const response = await apiFetch(`${API_BASE}/sources/${encodeURIComponent(sourceId)}/raw`, { signal });
  const result = await response.json() as { success: boolean; data?: SourceRawRecord; message?: string };
  if (!response.ok || !result.success || !result.data) throw new Error(result.message || '原文读取失败');
  return result.data;
}

export async function readGenerationPreview(response: Response): Promise<GenerationPreviewResult> {
  const result = await response.json() as Partial<GenerationPreviewResult> & { error?: string };
  const hasErrors = result.generation?.diagnostics.some(diagnostic => diagnostic.severity === 'error')
    || result.generation?.bindings.some(binding => binding.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
  const success = response.ok && result.success !== false && typeof result.data === 'string' && !hasErrors;
  return {
    success,
    nodeCount: result.nodeCount ?? result.generation?.nodeCount ?? 0,
    data: success ? result.data! : '',
    generation: result.generation,
    message: success ? undefined : result.message || result.error || `生成失败（HTTP ${response.status}）`,
  };
}
