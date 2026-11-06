import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

/** Rows drawn beyond the visible area, so fast scrolling does not show blanks. */
const OVERSCAN = 8;
/** The drawn range moves in steps this size, so React is not asked to render every few pixels. */
const RANGE_STEP = 4;

export interface WindowedListHandle {
  scrollToIndex: (index: number, align?: 'start' | 'nearest') => void;
  /** The row at the top of the visible area. */
  topIndex: () => number;
  /** The row under a point on screen. */
  indexAt: (clientY: number) => number;
}

interface Props {
  count: number;
  /** The height of every row in rem, so the list follows the interface size. */
  rowRem: number;
  label: string;
  className?: string;
  /** Arrow keys skip rows this rejects, such as year headings. */
  isFocusable?: (index: number) => boolean;
  rowKey?: (index: number) => string;
  /**
   * Draws one row. Give its main control `data-row-focus`, and all its controls this
   * `tabIndex`, so that Tab enters the list at one row and arrow keys move between rows.
   */
  renderRow: (index: number, tabIndex: 0 | -1) => ReactNode;
  handle?: Ref<WindowedListHandle>;
}

/**
 * A list that draws only the rows near the visible area. All rows share one height,
 * which keeps scrolling free of measurement and layout work.
 */
export function WindowedList(props: Props) {
  const { count, rowRem, label, className, isFocusable, rowKey, renderRow, handle } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const rowPx = useRef(rowRem * 16);
  const frame = useRef(0);
  const focusPending = useRef(false);
  const [range, setRange] = useState({ first: 0, last: 40 });
  const [active, setActive] = useState(-1);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    rowPx.current = (probe.current?.getBoundingClientRect().height || 16) * rowRem;
    const top = Math.floor(el.scrollTop / rowPx.current);
    const bottom = Math.ceil((el.scrollTop + el.clientHeight) / rowPx.current);
    const first = Math.max(0, Math.floor(top / RANGE_STEP) * RANGE_STEP - OVERSCAN);
    const last = Math.ceil(bottom / RANGE_STEP) * RANGE_STEP + OVERSCAN;
    setRange((r) => (r.first === first && r.last === last ? r : { first, last }));
  }, [rowRem]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (scroller.current) observer.observe(scroller.current);
    // A probe sized in rem also notices when the interface size changes.
    if (probe.current) observer.observe(probe.current);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => measure(), [count, measure]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'nearest' = 'start') => {
      const el = scroller.current;
      if (!el) return;
      const top = index * rowPx.current;
      if (align === 'start') {
        el.scrollTop = top;
      } else if (top < el.scrollTop) {
        el.scrollTop = top;
      } else if (top + rowPx.current > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + rowPx.current - el.clientHeight;
      }
      measure();
    },
    [measure],
  );

  useImperativeHandle(
    handle,
    () => ({
      scrollToIndex,
      topIndex: () => Math.floor((scroller.current?.scrollTop ?? 0) / rowPx.current),
      indexAt: (clientY) => {
        const el = scroller.current;
        if (!el) return 0;
        const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
        return Math.max(0, Math.min(count - 1, Math.floor(y / rowPx.current)));
      },
    }),
    [count, scrollToIndex],
  );

  const firstFocusable = useCallback(
    (from: number, step: 1 | -1) => {
      for (let i = from; i >= 0 && i < count; i += step) {
        if (!isFocusable || isFocusable(i)) return i;
      }
      return -1;
    },
    [count, isFocusable],
  );

  const activeIsUsable = active >= 0 && active < count && (!isFocusable || isFocusable(active));
  const tabStop = activeIsUsable ? active : firstFocusable(0, 1);

  const focusRow = (index: number) => {
    scroller.current
      ?.querySelector<HTMLElement>(`[data-row="${index}"] [data-row-focus]`)
      ?.focus({ preventScroll: true });
  };

  const moveTo = (index: number) => {
    if (index < 0) return;
    scrollToIndex(index, 'nearest');
    if (index === tabStop) {
      // Nothing changes, so no render would pick up a request to focus it later.
      focusRow(index);
      return;
    }
    focusPending.current = true;
    setActive(index);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowPx.current) - 1);
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = firstFocusable(tabStop + 1, 1);
        break;
      case 'ArrowUp':
        next = firstFocusable(tabStop - 1, -1);
        break;
      case 'PageDown':
        next = firstFocusable(Math.min(count - 1, tabStop + page), 1);
        break;
      case 'PageUp':
        next = firstFocusable(Math.max(0, tabStop - page), -1);
        break;
      case 'Home':
        next = firstFocusable(0, 1);
        break;
      case 'End':
        next = firstFocusable(count - 1, -1);
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== null) moveTo(next);
  };

  useLayoutEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    focusRow(tabStop);
  });

  // The row with keyboard focus stays drawn when scrolled away, or focus would be lost.
  const indexes: number[] = [];
  for (let i = range.first; i < Math.min(range.last, count); i += 1) indexes.push(i);
  if (tabStop >= 0 && (tabStop < range.first || tabStop >= range.last)) indexes.push(tabStop);

  return (
    <div
      ref={scroller}
      className={`windowed-list${className ? ` ${className}` : ''}`}
      role="list"
      aria-label={label}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
        if (row) setActive(Number(row.dataset.row));
      }}
    >
      <div ref={probe} className="windowed-list-probe" aria-hidden="true" />
      <div className="windowed-list-space" style={{ height: `${count * rowRem}rem` }}>
        {indexes.map((index) => (
          <div
            key={rowKey ? rowKey(index) : index}
            className="windowed-list-row"
            role="listitem"
            aria-setsize={count}
            aria-posinset={index + 1}
            data-row={index}
            style={{ top: `${index * rowRem}rem`, height: `${rowRem}rem` }}
          >
            {renderRow(index, index === tabStop ? 0 : -1)}
          </div>
        ))}
      </div>
    </div>
  );
}
