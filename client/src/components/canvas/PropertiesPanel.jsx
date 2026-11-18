import { Copy, Trash2, RotateCw } from 'lucide-react';

const FONT_OPTIONS = [
  { key: 'sans', label: 'Sans' }, { key: 'serif', label: 'Serif' },
  { key: 'mono', label: 'Mono' }, { key: 'hand', label: 'Handwriting' }
];
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96];
const selectStyle = { border: '1px solid #E5E7EB', borderRadius: 6, padding: '4px 6px', fontSize: 12 };
const panel = {
  position: 'absolute', top: 16, right: 16, zIndex: 10, width: 220,
  background: '#FFFFFF', border: '1px solid #E5E7EB', borderRadius: 10,
  boxShadow: '0 4px 16px rgba(17,24,39,0.08)', padding: 14,
  fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13, color: '#111827'
};
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 };
const label = { color: '#6B7280', fontSize: 12 };
const iconBtn = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 30, height: 30, borderRadius: 6, border: '1px solid #E5E7EB',
  background: '#FFFFFF', cursor: 'pointer', color: '#374151'
};
const colorSwatch = (c) => ({
  width: 24, height: 24, borderRadius: 6, border: '1px solid #E5E7EB',
  background: c, cursor: 'pointer', padding: 0
});

export default function PropertiesPanel({ objects, onStyleChange, onDuplicate, onDelete }) {
  if (!objects.length) return null;

  const first = objects[0];
  const isShapeLike = first.type === 'shape' || first.type === 'icon';
  const mixedColor = objects.some((o) => o.color !== first.color);
  const degrees = Math.round(((first.rotation ?? 0) * 180) / Math.PI) % 360;
  const isText = objects.length > 0 && objects.every((o) => o.type === 'text');
  return (
    <div style={panel}>
      <div style={{ ...row, marginBottom: 12 }}>
        <span style={{ fontWeight: 600 }}>
          {objects.length > 1 ? `${objects.length} selected` : isShapeLike ? (first.shapeType || first.iconName || 'Object') : 'Stroke'}
        </span>
      </div>

      <div style={row}>
        <span style={label}>{isShapeLike ? 'Fill' : 'Color'}</span>
        <input
          type="color"
          value={mixedColor ? '#000000' : first.color}
          onChange={(e) => onStyleChange({ color: e.target.value })}
          style={colorSwatch(mixedColor ? '#fff' : first.color)}
          title={mixedColor ? 'Mixed — click to set one color' : first.color}
        />
      </div>

      {isText && (
        <>
          <div style={row}>
            <span style={label}>Font</span>
            <select value={first.fontFamily || 'sans'} onChange={(e) => onStyleChange({ fontFamily: e.target.value })} style={selectStyle}>
              {FONT_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
          <div style={row}>
            <span style={label}>Size</span>
            <select value={first.fontSize ?? 20} onChange={(e) => onStyleChange({ fontSize: parseInt(e.target.value, 10) })} style={selectStyle}>
              {FONT_SIZES.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
            </select>
          </div>
        </>
      )}
      {isText && objects.length === 1 && (
        <div style={row}>
          <span style={label}>Size</span>
          <input
            type="range" min="8" max="96" value={first.fontSize ?? 20}
            onChange={(e) => onStyleChange({ fontSize: parseInt(e.target.value, 10) })}
            style={{ width: 110 }}
          />
        </div>
      )}

      {isShapeLike && objects.length === 1 && (
        <>
          <div style={row}>
            <span style={label}>Rotation</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{degrees}°</span>
          </div>
          <div style={row}>
            <button
              style={iconBtn}
              title="Rotate 15°"
              onClick={() => onStyleChange({ rotation: (first.rotation ?? 0) + Math.PI / 12 })}
            >
              <RotateCw size={15} />
            </button>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4, borderTop: '1px solid #E5E7EB', paddingTop: 12 }}>
        <button style={iconBtn} title="Duplicate" onClick={onDuplicate}><Copy size={15} /></button>
        <button style={{ ...iconBtn, color: '#DC2626', borderColor: '#FCA5A5' }} title="Delete" onClick={onDelete}>
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}