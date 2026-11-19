import { useEffect, useRef, useState } from 'react';
import { Hexagon, Star } from 'lucide-react';
import { SHAPES } from './shapes';
import { MDI_CATEGORIES, MDI_PATHS } from './mdiSubset';
import './ToolPickers.css';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

export function ShapePicker({ onPick }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="picker">
      <button
        type="button"
        className={`picker__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Shapes"
        aria-label="Shapes"
      >
        <Hexagon size={17} />
      </button>
      {open && (
        <div className="picker__pop picker__pop--shapes">
          {Object.entries(SHAPES).map(([key, s]) => {
            const pts = s.points.reduce((a, v, i) => a + (i % 2 ? `${v} ` : `${v},`), '');
            const Tag = s.closed ? 'polygon' : 'polyline';
            return (
              <button
                key={key}
                type="button"
                title={s.label}
                className="picker__cell picker__cell--shape"
                onClick={() => { onPick(key); setOpen(false); }}
              >
                <svg width="28" height="28" viewBox="-60 -60 120 120">
                  <Tag points={pts} fill="none" stroke="currentColor" strokeWidth="7" strokeLinejoin="round" />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function IconPicker({ onPick }) {
  const { open, setOpen, ref } = usePopover();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const groups = MDI_CATEGORIES
    .map(([title, names]) => [title, title.toLowerCase().includes(query) ? names : names.filter((n) => n.replace(/-/g, ' ').includes(query) || n.includes(query))])
    .filter(([, names]) => names.length);

  return (
    <div ref={ref} className="picker">
      <button
        type="button"
        className={`picker__btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Icons"
        aria-label="Icons"
      >
        <Star size={17} />
      </button>
      {open && (
        <div className="picker__pop picker__pop--icons">
          <input
            autoFocus
            className="picker__search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search icons…"
          />
          <div className="picker__scroll">
            {groups.length === 0 && <div className="picker__empty">No icons match “{q}”</div>}
            {groups.map(([title, names]) => (
              <div key={title}>
                <div className="picker__group">{title}</div>
                <div className="picker__icons">
                  {names.map((n) => (
                    <button
                      key={n}
                      type="button"
                      title={n}
                      className="picker__cell"
                      onClick={() => { onPick(n); setOpen(false); setQ(''); }}
                    >
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d={MDI_PATHS[n]} /></svg>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
