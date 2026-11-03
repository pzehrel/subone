export interface SubscriptionInfo {
  upload?: number;
  download?: number;
  total?: number;
  remaining?: number;
  used?: number;
  expire?: number;
  trafficText?: string;
  expiryText?: string;
}

export function selectSubscriptionSources<T extends { id: string; enabled: boolean }>(
  sources: readonly T[],
  sourceIds?: readonly string[],
): T[] {
  const selected = Array.isArray(sourceIds) && sourceIds.length ? new Set(sourceIds) : undefined;
  const seen = new Set<string>();
  return sources.filter(source => {
    if (!source.enabled || (selected && !selected.has(source.id)) || seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

function amount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value : undefined;
}

function sum(values: (number | undefined)[]): number | undefined {
  if (!values.length || values.some(value => value === undefined)) return undefined;
  return amount(values.reduce<number>((total, value) => total + value!, 0));
}

/** Unknown fields stay unknown; a zero quota means unlimited, and expiry uses the earliest date. */
export function aggregateSubscriptionInfo(
  values: readonly (SubscriptionInfo | undefined)[],
): SubscriptionInfo | undefined {
  const infos = values.filter((info): info is SubscriptionInfo => !!info);
  const traffic = infos.filter(info =>
    [info.upload, info.download, info.used, info.total, info.remaining].some(value => amount(value) !== undefined));
  const usage = traffic.map(info => {
    const upload = amount(info.upload);
    const download = amount(info.download);
    const total = amount(info.total);
    const remaining = amount(info.remaining);
    const used = amount(info.used)
      ?? (upload !== undefined && download !== undefined ? amount(upload + download) : undefined)
      ?? (total !== undefined && total > 0 && remaining !== undefined ? Math.max(0, total - remaining) : undefined);
    return {
      upload,
      download,
      total,
      used,
      remaining: remaining ?? (total !== undefined && total > 0 && used !== undefined ? Math.max(0, total - used) : undefined),
    };
  });
  const unlimited = usage.some(info => info.total === 0);
  const info: SubscriptionInfo = {};
  for (const key of ['upload', 'download', 'used', 'total', 'remaining'] as const) {
    const value = key === 'total' && unlimited ? 0
      : key === 'remaining' && unlimited ? undefined
      : sum(usage.map(item => item[key]));
    if (value !== undefined) info[key] = value;
  }

  const expiries = infos.map(item => amount(item.expire)).filter((value): value is number => value !== undefined);
  const finiteExpiries = expiries.filter(value => value > 0);
  if (finiteExpiries.length) info.expire = Math.min(...finiteExpiries);
  else if (expiries.length) info.expire = 0;

  if (!traffic.length) {
    const text = infos.map(item => item.trafficText).filter(Boolean).join(' · ');
    if (text) info.trafficText = text;
  }
  if (info.expire === undefined) {
    const text = infos.map(item => item.expiryText).filter(Boolean).join(' · ');
    if (text) info.expiryText = text;
  }
  return Object.keys(info).length ? info : undefined;
}
