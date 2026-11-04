import type { ComponentPropsWithRef } from 'react';
import { useField } from './form-context';

type InputProps = ComponentPropsWithRef<'input'> & { controlSize?: 'sm' | 'md' };

export function Input({ id, type = 'text', className = '', controlSize = 'md', ...props }: InputProps) {
  const field = useField();
  const choice = type === 'checkbox' || type === 'radio';
  return <input {...props} id={id ?? field?.id} type={type} aria-describedby={props['aria-describedby'] ?? field?.describedBy} aria-invalid={props['aria-invalid'] ?? (field?.invalid || undefined)} data-size={controlSize} className={`${choice ? 'ui-choice' : 'ui-control ui-input'} ${className}`} />;
}
