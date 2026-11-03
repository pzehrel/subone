import { useEffect, useId, useRef, useState } from 'react';
import type { FormHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ModalCloseButton } from './ModalCloseButton';
import { ModalLayerContext } from './modal-layer';

interface ModalProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'wide';
  layout?: 'content' | 'editor';
  onClose: () => void;
  children: ReactNode;
}

type ModalSnapshot = Pick<ModalProps, 'title' | 'description' | 'children'>;
const activeModals: HTMLDivElement[] = [];
let originalBodyStyle = { overflow: '', paddingRight: '' };

export function Modal({ open, title, description, size = 'md', layout = 'content', onClose, children }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [snapshot, setSnapshot] = useState<ModalSnapshot | null>(null);

  if (open && (!snapshot || snapshot.children !== children || snapshot.title !== title || snapshot.description !== description)) {
    setSnapshot({ title, description, children });
  }

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const previousFocus = document.activeElement;
    if (activeModals.length === 0) {
      originalBodyStyle = { overflow: document.body.style.overflow, paddingRight: document.body.style.paddingRight };
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const currentPadding = Number.parseFloat(getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
    }
    const previousModal = activeModals.at(-1);
    if (previousModal) {
      previousModal.inert = true;
      previousModal.setAttribute('aria-hidden', 'true');
    }
    root.style.zIndex = String(50 + activeModals.length * 10);
    activeModals.push(root);
    panel.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || activeModals.at(-1) !== root) return;
      if (event.target instanceof Element && event.target.closest('[data-ui-select-content]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]'));
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = activeModals.indexOf(root);
      const wasTop = index === activeModals.length - 1;
      if (index !== -1) activeModals.splice(index, 1);
      const top = activeModals.at(-1);
      if (top && wasTop) {
        top.inert = false;
        top.setAttribute('aria-hidden', 'false');
      }
      if (activeModals.length === 0) Object.assign(document.body.style, originalBodyStyle);
      if (wasTop && previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus();
    };
  }, [open]);

  if (!open && !snapshot) return null;
  const displayed = open ? { title, description, children } : snapshot!;

  return createPortal(
    <div
      ref={rootRef}
      data-state={open ? 'open' : 'closing'}
      aria-hidden={!open}
      inert={!open}
      onClick={event => { if (event.target === event.currentTarget && activeModals.at(-1) === rootRef.current) onClose(); }}
      onAnimationEnd={event => { if (event.target === event.currentTarget && !open) setSnapshot(null); }}
      className="ui-modal-backdrop"
    >
      <ModalLayerContext.Provider value={rootRef}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={displayed.description ? descriptionId : undefined}
          tabIndex={-1}
          data-size={size}
          data-layout={layout}
          className="ui-modal-panel"
        >
          <div className="ui-modal-header">
            <div className="min-w-0">
              <h2 id={titleId} className="ui-modal-title">{displayed.title}</h2>
              {displayed.description && <div id={descriptionId} className="ui-modal-description">{displayed.description}</div>}
            </div>
            <ModalCloseButton onClick={onClose} />
          </div>
          <div className="ui-modal-content">{displayed.children}</div>
        </div>
      </ModalLayerContext.Provider>
    </div>,
    document.body,
  );
}

export function ModalForm({ className = '', ...props }: FormHTMLAttributes<HTMLFormElement>) {
  return <form {...props} className={`ui-modal-form ${className}`} />;
}

export function ModalBody({ children, editor = false, className = '' }: { children: ReactNode; editor?: boolean; className?: string }) {
  return <div data-editor={editor || undefined} className={`ui-modal-body ${className}`}>{children}</div>;
}

export function ModalFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ui-modal-footer ${className}`}>{children}</div>;
}
