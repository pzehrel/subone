import type { ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';

type ModalCloseButtonProps = Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled' | 'title' | 'className'>;

export function ModalCloseButton({ className = '', ...props }: ModalCloseButtonProps) {
  return (
    <button
      {...props}
      type="button"
      aria-label="关闭弹窗"
      className={`ui-modal-close ${className}`}
    >
      <X size={16} aria-hidden="true" />
    </button>
  );
}
