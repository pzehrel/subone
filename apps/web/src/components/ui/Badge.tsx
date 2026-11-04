import type { ComponentPropsWithRef } from 'react';

type BadgeProps = ComponentPropsWithRef<'span'> & { tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info' | 'inverse' };

export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return <span {...props} data-tone={tone} className={`ui-badge ${className}`} />;
}
