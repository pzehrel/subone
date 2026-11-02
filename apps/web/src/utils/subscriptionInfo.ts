import type { SubscriptionInfo } from '../types';

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  const power = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${Number((value / 1024 ** power).toFixed(2))} ${units[power]}`;
}

export function formatSubscriptionTraffic(info?: SubscriptionInfo): string | undefined {
  if (!info) return undefined;
  if (info.trafficText) return info.trafficText;
  const parts: string[] = [];
  const used = info.used ?? (info.upload !== undefined && info.download !== undefined ? info.upload + info.download : undefined);
  if (used !== undefined) parts.push(`已用 ${formatBytes(used)}`);
  else {
    if (info.upload !== undefined) parts.push(`上传 ${formatBytes(info.upload)}`);
    if (info.download !== undefined) parts.push(`下载 ${formatBytes(info.download)}`);
  }
  if (info.total !== undefined) parts.push(info.total === 0 ? '不限量' : `共 ${formatBytes(info.total)}`);
  if (info.remaining !== undefined) parts.push(`剩余 ${formatBytes(info.remaining)}`);
  return parts.length ? parts.join(' / ') : undefined;
}

export function formatSubscriptionExpiry(info?: SubscriptionInfo): string | undefined {
  if (!info) return undefined;
  if (info.expiryText) return info.expiryText;
  if (info.expire === undefined) return undefined;
  if (info.expire === 0) return '长期有效';
  const date = new Date(info.expire * 1000);
  return Number.isFinite(date.getTime()) ? `到期：${date.toLocaleString()}` : undefined;
}
