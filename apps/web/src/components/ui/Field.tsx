import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { FieldContext, useField } from './form-context';

type FieldProps = ComponentPropsWithRef<'div'> & { hint?: ReactNode; error?: ReactNode };

export function Field({ id: suppliedId, className = '', children, hint, error, ...props }: FieldProps) {
  const generatedId = useId();
  const id = suppliedId || generatedId;
  return (
    <FieldContext.Provider value={{ id, hintId: `${id}-hint`, errorId: `${id}-error`, describedBy: [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined, invalid: !!error }}>
      <div {...props} className={`ui-field ${className}`}>
        {children}
        {hint && <FieldHint>{hint}</FieldHint>}
        {error && <FieldError>{error}</FieldError>}
      </div>
    </FieldContext.Provider>
  );
}

export function Label({ htmlFor, className = '', ...props }: ComponentPropsWithRef<'label'>) {
  const field = useField();
  return <label {...props} htmlFor={htmlFor ?? field?.id} className={`ui-label ${className}`} />;
}

export function FieldHint({ id, className = '', ...props }: ComponentPropsWithRef<'p'>) {
  const field = useField();
  return <p {...props} id={id ?? field?.hintId} className={`ui-field-hint ${className}`} />;
}

export function FieldError({ id, className = '', ...props }: ComponentPropsWithRef<'p'>) {
  const field = useField();
  return <p {...props} id={id ?? field?.errorId} role="alert" className={`ui-field-error ${className}`} />;
}
