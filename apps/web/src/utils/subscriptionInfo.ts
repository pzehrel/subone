import type { SubscriptionInfo } from '../types';

const units = ['B', 'K', 'M', 'G', 'T', 'P', 'E'];
const unitPower = (value: number) => value > 0
  ? Math.max(0, Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)) : 0;
const formatAmount = (value: number, power: number) => Number((value / 1024 ** power).toFixed(2));

function formatBytes(value: number): string {
  const power = unitPower(value);
  return `${formatAmount(value, power)} ${units[power]}`;
}

export function formatSubscriptionTraffic(info?: SubscriptionInfo): string | undefined {
  if (!info) return undefined;
  const used = info.used
    ?? (info.upload !== undefined && info.download !== undefined ? info.upload + info.download : undefined)
    ?? (info.total !== undefined && info.total > 0 && info.remaining !== undefined ? Math.max(0, info.total - info.remaining) : undefined);
  if (used !== undefined && info.total !== undefined && info.total > 0) {
    const power = unitPower(info.total);
    return `${formatAmount(used, power)}/${formatAmount(info.total, power)} ${units[power]}`;
  }
  if (info.trafficText) return info.trafficText;
  const parts: string[] = [];
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
  if (!info || info.expire === undefined || !Number.isFinite(info.expire) || info.expire <= 0) return undefined;
  const date = new Date(info.expire * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
