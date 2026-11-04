import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';

interface HelpTooltipProps {
  content: ReactNode;
  label?: string;
}

export function HelpTooltip({ content, label = '帮助' }: HelpTooltipProps) {
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const cancelHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelHide();
    pinned.current = false;
    setIsOpen(false);
  }, [cancelHide]);

  const show = () => {
    cancelHide();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(288, window.innerWidth - 32);
    const above = window.innerHeight - rect.bottom < 160 && rect.top > 160;
    setPosition({
      left: Math.max(16, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 16)),
      top: above ? rect.top - 8 : rect.bottom + 8,
      width,
      above,
    });
    setIsOpen(true);
  };

  const scheduleHide = () => {
    cancelHide();
    if (!pinned.current) hideTimer.current = setTimeout(close, 150);
  };

  useEffect(() => cancelHide, [cancelHide]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !tooltipRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [isOpen, close]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-describedby={isOpen ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={() => {
          if (pinned.current) close();
          else {
            pinned.current = true;
            show();
          }
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-ui-muted hover:text-ui-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-accent cursor-pointer"
      >
        <CircleHelp size={14} aria-hidden="true" />
      </button>
      {createPortal(
        <div
          style={{
            position: 'fixed',
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            width: position?.width ?? 288,
            transform: position?.above ? 'translateY(-100%)' : undefined,
          }}
          className="pointer-events-none z-[100]"
        >
          <div
            ref={tooltipRef}
            id={id}
            role="tooltip"
            aria-hidden={!isOpen}
            onPointerEnter={cancelHide}
            onPointerLeave={scheduleHide}
            style={{ transform: `translateY(${isOpen ? 0 : position?.above ? 4 : -4}px)` }}
            className={`rounded-xl border border-ui-border bg-ui-surface px-3 py-2 text-xs leading-relaxed text-ui-secondary shadow-lg break-words transition-[opacity,transform,visibility] duration-[var(--ui-duration)] ease-out motion-reduce:transition-none ${isOpen ? 'visible opacity-100 pointer-events-auto' : 'invisible opacity-0 pointer-events-none'}`}
          >
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
