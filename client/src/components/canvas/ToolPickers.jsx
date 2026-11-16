import { useEffect, useRef, useState } from 'react';
import { SHAPES } from './shapes';
import { MDI_CATEGORIES, MDI_PATHS } from './mdiSubset';

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

const trigger = { padding: '4px 8px', cursor: 'pointer', borderRadius: 4, border: '1px solid #ccc', background: 'white' };
const pop = {
  position: 'absolute', bottom: 'calc(100% + 10px)', left: 0, zIndex: 20, background: 'white',
  border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', padding: 8
};
const cell = { width: 40, height: 40, display: 'grid', placeItems: 'center', cursor: 'pointer', border: '1px solid transparent', borderRadius: 6, background: 'transparent' };

export function ShapePicker({ onPick }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={trigger} onClick={() => setOpen((o) => !o)} title="Shapes">⬡ Shapes</button>
      {open && (
        <div style={{ ...pop, display: 'grid', gridTemplateColumns: 'repeat(3, 44px)', gap: 4 }}>
          {Object.entries(SHAPES).map(([key, s]) => {
            const pts = s.points.reduce((a, v, i) => a + (i % 2 ? `${v} ` : `${v},`), '');
            const Tag = s.closed ? 'polygon' : 'polyline';
            return (
              <button key={key} title={s.label} style={{ ...cell, width: 44, height: 44 }} onClick={() => { onPick(key); setOpen(false); }}>
                <svg width="28" height="28" viewBox="-60 -60 120 120"><Tag points={pts} fill="none" stroke="currentColor" strokeWidth="7" strokeLinejoin="round" /></svg>
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
    <div ref={ref} style={{ position: 'relative' }}>
      <button style={trigger} onClick={() => setOpen((o) => !o)} title="Icons">★ Icons</button>
      {open && (
        <div style={{ ...pop, width: 340 }}>
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search icons…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, marginBottom: 8 }}
          />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {groups.length === 0 && <div style={{ padding: 8, color: '#6b7280', fontSize: 13 }}>No icons match “{q}”</div>}
            {groups.map(([title, names]) => (
              <div key={title}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', margin: '6px 2px 4px', textTransform: 'uppercase' }}>{title}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                  {names.map((n) => (
                    <button key={n} title={n} style={cell} onClick={() => { onPick(n); setOpen(false); setQ(''); }}>
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