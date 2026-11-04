import { useContext, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-popover';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { ModalLayerContext } from '../modal-layer';

export interface PopconfirmProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactElement;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  disabled?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popconfirm({
  title, description, children, onConfirm, onCancel,
  confirmText = '确定', cancelText = '取消', danger = false, disabled = false,
  side = 'top', align = 'end', open: suppliedOpen, onOpenChange,
}: PopconfirmProps) {
  const layer = useContext(ModalLayerContext);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirming = useRef(false);
  const [internalOpen, setInternalOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const open = !disabled && (suppliedOpen ?? internalOpen);

  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  const requestOpen = (next: boolean) => {
    if (disabled || confirming.current) return;
    if (next) setError('');
    else if (open) onCancel?.();
    setOpen(next);
  };
  const confirm = async () => {
    if (confirming.current) return;
    confirming.current = true;
    setPending(true);
    setError('');
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请重试');
    } finally {
      confirming.current = false;
      setPending(false);
    }
  };

  return (
    <Primitive.Root open={open} onOpenChange={requestOpen}>
      <Primitive.Trigger asChild disabled={disabled || pending} onClick={event => event.stopPropagation()}>
        {children}
      </Primitive.Trigger>
      <Primitive.Portal container={layer?.current ?? undefined}>
        <Primitive.Content
          role="alertdialog"
          aria-busy={pending || undefined}
          aria-hidden={!open || undefined}
          inert={!open}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          hideWhenDetached
          className="ui-popconfirm"
          data-ui-popconfirm-content=""
          data-danger={danger || undefined}
          onClick={event => event.stopPropagation()}
          onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }}
          onEscapeKeyDown={event => { event.stopPropagation(); if (confirming.current) event.preventDefault(); }}
          onInteractOutside={event => { if (confirming.current) event.preventDefault(); }}
        >
          <div className="ui-popconfirm-body">
            <div className="ui-popconfirm-message">
              <CircleAlert size={18} className="ui-popconfirm-icon" aria-hidden="true" />
              <div className="ui-popconfirm-copy">
                <Primitive.Title className="ui-popconfirm-title">{title}</Primitive.Title>
                {description && <Primitive.Description className="ui-popconfirm-description">{description}</Primitive.Description>}
              </div>
            </div>
            {error && <p role="alert" className="ui-popconfirm-error">{error}</p>}
            <div className="ui-popconfirm-actions">
              <button ref={cancelRef} type="button" disabled={pending} className="ui-button-secondary" onClick={() => requestOpen(false)}>
                {cancelText}
              </button>
              <button type="button" disabled={pending} className={danger ? 'ui-button-danger' : 'ui-button-primary'} onClick={confirm}>
                {pending && <LoaderCircle size={14} className="ui-popconfirm-spinner" aria-hidden="true" />}
                {pending ? '处理中...' : confirmText}
              </button>
            </div>
          </div>
          <Primitive.Arrow className="ui-popconfirm-arrow" width={12} height={6} />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
