import type { ComponentPropsWithRef } from 'react';
import { useField } from './form-context';

type TextareaProps = ComponentPropsWithRef<'textarea'> & { variant?: 'default' | 'code' };

export function Textarea({ id, className = '', variant = 'default', ...props }: TextareaProps) {
  const field = useField();
  return <textarea {...props} id={id ?? field?.id} aria-describedby={props['aria-describedby'] ?? field?.describedBy} aria-invalid={props['aria-invalid'] ?? (field?.invalid || undefined)} data-variant={variant} className={`ui-control ui-textarea ${className}`} />;
}
