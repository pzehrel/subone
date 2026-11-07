import type { SubscriptionSource } from '../types';

export function isUpstreamSource(source: SubscriptionSource): boolean {
  return source.acquisition === 'manual' || /^https?:\/\//i.test(source.url || '');
}
