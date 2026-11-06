import type { ProxyNode, SubscriptionInfo, SubscriptionSource } from '../../types/index';

export function validateInfoRegex(source: Pick<SubscriptionSource, 'trafficNodeRegex' | 'expiryNodeRegex'>): void {
  for (const [field, label] of [['trafficNodeRegex', '流量'], ['expiryNodeRegex', '到期时间']] as const) {
    const pattern = source[field];
    if (pattern !== undefined && typeof pattern !== 'string') throw new Error(`${label}正则必须是文本`);
    try {
      if (pattern?.trim()) new RegExp(pattern.trim(), 'i');
    } catch {
      throw new Error(`${label}正则无效，请检查表达式`);
    }
  }
}

export function parseSubscriptionUserinfo(value?: string | null): SubscriptionInfo {
  const info: SubscriptionInfo = {};
  for (const part of (value || '').split(';')) {
    const match = part.trim().match(/^(upload|download|total|expire)\s*=\s*(\d+)$/i);
    if (!match) continue;
    const number = Number(match[2]);
    if (Number.isSafeInteger(number)) info[match[1].toLowerCase() as 'upload' | 'download' | 'total' | 'expire'] = number;
  }
  return info;
}

export function formatSubscriptionUserinfo(info?: SubscriptionInfo): string {
  if (!info) return '';
  let { upload, download } = info;
  // Node-name notices may provide combined usage without an upload/download split.
  if (info.used !== undefined && Number.isFinite(info.used) && info.used >= 0 && info.used <= Number.MAX_SAFE_INTEGER) {
    upload ??= download !== undefined ? Math.max(0, info.used - download) : 0;
    download ??= Math.max(0, info.used - upload);
  }
  return Object.entries({ upload, download, total: info.total, expire: info.expire })
    .filter((entry): entry is [string, number] =>
      entry[1] !== undefined && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= Number.MAX_SAFE_INTEGER)
    .map(([key, value]) => `${key}=${Math.floor(value)}`).join('; ');
}

const amountPattern = String.raw`(\d+(?:\.\d+)?)\s*((?:[KMGTPE]i?B)|B)(?![a-z])`;

function bytes(amount: string, unit: string): number {
  const power = 'BKMGTPE'.indexOf(unit[0].toUpperCase());
  return Number(amount) * 1024 ** power;
}

function parseTraffic(text: string): SubscriptionInfo {
  const info: SubscriptionInfo = {};
  const pair = text.match(new RegExp(`${amountPattern}\\s*[/／]\\s*${amountPattern}`, 'i'));
  // A pair such as “已用 10 GB / 100 GB” represents used / total.
  if (pair && !/(剩余|remaining)/i.test(text.slice(0, pair.index))) {
    info.used = bytes(pair[1], pair[2]);
    info.total = bytes(pair[3], pair[4]);
  }
  for (const [key, label] of [
    ['remaining', '(?:剩余(?:流量)?|remaining)'],
    ['used', '(?:已用(?:流量)?|已使用(?:流量)?|used)'],
    ['total', '(?:总流量|总量|total)'],
  ] as const) {
    const match = text.match(new RegExp(`${label}\\s*[:：]?\\s*${amountPattern}`, 'i'));
    if (match) info[key] = bytes(match[1], match[2]);
  }
  return info;
}

function parseExpiry(text: string): number | undefined {
  if (/(永久|长期有效|不限期|never|unlimited)/i.test(text)) return 0;
  const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?/);
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00', zone = ''] = match;
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  // Check the calendar date before Date.parse can normalize invalid dates.
  const calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) return undefined;
  const timestamp = Date.parse(`${date}T${hour.padStart(2, '0')}:${minute}:${second}${zone}`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : undefined;
}

/** Reclassify cached nodes without contacting the subscription URL. */
export function applySubscriptionInfo(
  source: SubscriptionSource,
  nodes: ProxyNode[],
  userinfo: string | null | undefined = source.subscriptionUserinfo,
): ProxyNode[] {
  validateInfoRegex(source);
  const trafficRegex = source.trafficNodeRegex?.trim() ? new RegExp(source.trafficNodeRegex.trim(), 'i') : undefined;
  const expiryRegex = source.expiryNodeRegex?.trim() ? new RegExp(source.expiryNodeRegex.trim(), 'i') : undefined;
  const trafficNames: string[] = [];
  const expiryNames: string[] = [];
  const infoNodes: ProxyNode[] = [];
  const available: ProxyNode[] = [];
  for (const node of nodes) {
    const originalName = node.originalName ?? node.name;
    const traffic = trafficRegex?.test(originalName);
    const expiry = expiryRegex?.test(originalName);
    if (traffic) trafficNames.push(originalName);
    if (expiry) expiryNames.push(originalName);
    if (traffic || expiry) infoNodes.push(node);
    else available.push(node);
  }

  const header = parseSubscriptionUserinfo(userinfo);
  const trafficText = trafficNames.join(' · ');
  const expiryText = expiryNames.join(' · ');
  const hasHeaderTraffic = header.upload !== undefined || header.download !== undefined || header.total !== undefined;
  // Do not combine header usage with a potentially stale node-name quota.
  const info: SubscriptionInfo = hasHeaderTraffic ? { ...header } : { ...parseTraffic(trafficText), ...header };
  if (!hasHeaderTraffic && trafficText) {
    info.trafficText = trafficText;
  }
  if (header.expire === undefined && expiryText) {
    info.expiryText = expiryText;
    info.expire = parseExpiry(expiryText);
  }

  source.infoNodes = infoNodes;
  source.subscriptionUserinfo = userinfo || undefined;
  source.subscriptionInfo = Object.keys(info).length ? info : undefined;
  return available;
}
