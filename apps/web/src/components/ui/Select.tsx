import { Children, Fragment, isValidElement, useContext, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { ModalLayerContext } from '../modal-layer';
import { useField } from './form-context';

const encodeValue = (value: string) => `value:${value}`;
const decodeValue = (value: string) => value.slice('value:'.length);

interface SelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange'> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  controlSize?: 'sm' | 'md';
  placeholder?: string;
  children: ReactNode;
}

interface SelectItemProps { value: string; disabled?: boolean; children: ReactNode; }

function nativeOptions(children: ReactNode): SelectItemProps[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<SelectItemProps>(child)) return [];
    if (child.type === SelectItem) return [child.props];
    if (child.type === Fragment) return nativeOptions(child.props.children);
    return [];
  });
}

function plainText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : String(child)).join('');
}

export function Select({ id, value: suppliedValue, defaultValue = '', onValueChange, name, required, disabled, children, className = '', controlSize = 'md', placeholder = '请选择', ...props }: SelectProps) {
  const field = useField();
  const layer = useContext(ModalLayerContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [invalid, setInvalid] = useState(false);
  const value = suppliedValue ?? internalValue;
  const options = nativeOptions(children);
  const hasSelection = options.some(option => option.value === value);
  useEffect(() => {
    const form = triggerRef.current?.closest('form');
    if (!form || suppliedValue !== undefined) return;
    const reset = (event: Event) => queueMicrotask(() => {
      if (!event.defaultPrevented) { setInternalValue(defaultValue); setInvalid(false); }
    });
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [defaultValue, suppliedValue]);
  const change = (next: string) => {
    setInternalValue(next);
    setInvalid(false);
    onValueChange?.(next);
  };

  return (
    <Primitive.Root open={open} onOpenChange={setOpen} value={encodeValue(value)} onValueChange={next => change(decodeValue(next))} disabled={disabled}>
      <Primitive.Trigger
        {...props}
        ref={triggerRef}
        id={id ?? field?.id}
        aria-required={required || undefined}
        aria-invalid={props['aria-invalid'] ?? ((invalid || field?.invalid) || undefined)}
        aria-describedby={props['aria-describedby'] ?? field?.describedBy}
        data-size={controlSize}
        className={`ui-control ui-select-trigger ${className}`}
      >
        <span className="ui-select-value"><Primitive.Value>{!hasSelection ? placeholder : undefined}</Primitive.Value></span>
        <Primitive.Icon className="ui-select-icon"><ChevronDown size={16} aria-hidden="true" /></Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={layer?.current ?? undefined}>
        <Primitive.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className="ui-select-content"
          data-ui-select-content=""
          onEscapeKeyDown={event => event.stopPropagation()}
        >
          <Primitive.ScrollUpButton className="ui-select-scroll-button"><ChevronUp size={14} aria-hidden="true" /></Primitive.ScrollUpButton>
          <Primitive.Viewport className="ui-select-viewport">{children}</Primitive.Viewport>
          <Primitive.ScrollDownButton className="ui-select-scroll-button"><ChevronDown size={14} aria-hidden="true" /></Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
      {(name || required) && (
        <select
          aria-hidden="true"
          tabIndex={-1}
          name={name}
          value={value}
          required={required}
          disabled={disabled}
          className="ui-select-native"
          onChange={event => change(event.target.value)}
          onInvalid={event => { event.preventDefault(); setInvalid(true); triggerRef.current?.focus(); }}
        >
          <option value="" hidden />
          {options.map((option, index) => <option key={index} value={option.value} disabled={option.disabled}>{plainText(option.children)}</option>)}
        </select>
      )}
    </Primitive.Root>
  );
}

export function SelectItem({ value, disabled, children }: SelectItemProps) {
  return (
    <Primitive.Item value={encodeValue(value)} disabled={disabled} textValue={plainText(children)} title={plainText(children)} className="ui-select-item">
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator className="ui-select-indicator"><Check size={14} aria-hidden="true" /></Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
