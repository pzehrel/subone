import type { SourceRawRecord } from './types';

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
