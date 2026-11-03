import { useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { ComponentPropsWithRef, CSSProperties } from 'react';

type TableProps = ComponentPropsWithRef<'table'> & { label: string };

export function Table({ label, className = '', children, ref, ...props }: TableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  useImperativeHandle(ref, () => tableRef.current!, []);

  const updateScrollEdges = () => {
    const container = containerRef.current;
    if (!container) return;
    container.dataset.scrollLeft = String(container.scrollLeft > 1);
    container.dataset.scrollRight = String(container.scrollWidth - container.clientWidth - container.scrollLeft > 1);
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    const table = tableRef.current;
    if (!container || !table) return;
    const fixedCells = table.querySelectorAll<HTMLTableCellElement>('[data-fixed]');
    const measure = () => {
      const positions: { cell: HTMLTableCellElement; offset: number; edge: boolean }[] = [];
      for (const row of Array.from(table.rows)) {
        for (const side of ['left', 'right']) {
          const cells = Array.from(row.cells).filter(cell => cell.dataset.fixed === side);
          if (side === 'right') cells.reverse();
          let offset = 0;
          cells.forEach((cell, index) => {
            positions.push({ cell, offset, edge: index === cells.length - 1 });
            offset += cell.getBoundingClientRect().width;
          });
        }
      }
      positions.forEach(({ cell, offset, edge }) => {
        cell.style.setProperty('--ui-table-fixed-offset', `${offset}px`);
        cell.dataset.fixedEdge = String(edge);
      });
      updateScrollEdges();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(table);
    fixedCells.forEach(cell => observer.observe(cell));
    measure();
    return () => observer.disconnect();
  }, [children]);

  return (
    <div ref={containerRef} className="ui-table-scroll" role="region" aria-label={label} tabIndex={0} onScroll={updateScrollEdges}>
      <table {...props} ref={tableRef} className={`ui-table ${className}`}>{children}</table>
    </div>
  );
}

type FixedColumnProps = { fixed?: 'left' | 'right' };

export function TableHead({ fixed, className = '', ...props }: ComponentPropsWithRef<'th'> & FixedColumnProps) {
  return <th {...props} data-fixed={fixed} scope={props.scope ?? 'col'} className={`ui-table-head ${className}`} />;
}

type TableCellProps = ComponentPropsWithRef<'td'> & FixedColumnProps & {
  minWidth?: CSSProperties['minWidth'];
  maxWidth?: CSSProperties['maxWidth'];
  truncate?: boolean;
};

export function TableCell({ fixed, minWidth, maxWidth, truncate = false, children, className = '', ...props }: TableCellProps) {
  return (
    <td {...props} data-fixed={fixed} className={`ui-table-cell ${className}`}>
      <div className="ui-table-cell-content" data-bounded={maxWidth !== undefined ? true : undefined} data-truncate={truncate || undefined} style={{ minWidth, maxWidth }}>{children}</div>
    </td>
  );
}
