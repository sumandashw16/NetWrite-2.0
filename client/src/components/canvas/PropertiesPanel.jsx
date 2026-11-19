import { Copy, Trash2, RotateCw } from 'lucide-react';
import './PropertiesPanel.css';

const FONT_OPTIONS = [
  { key: 'sans', label: 'Sans' }, { key: 'serif', label: 'Serif' },
  { key: 'mono', label: 'Mono' }, { key: 'hand', label: 'Handwriting' }
];
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96];

export default function PropertiesPanel({ objects, onStyleChange, onDuplicate, onDelete }) {
  if (!objects.length) return null;

  const first = objects[0];
  const isShapeLike = first.type === 'shape' || first.type === 'icon';
  const mixedColor = objects.some((o) => o.color !== first.color);
  const degrees = Math.round(((first.rotation ?? 0) * 180) / Math.PI) % 360;
  const isText = objects.length > 0 && objects.every((o) => o.type === 'text');

  return (
    <div className="pp">
      <div className="pp__title">
        {objects.length > 1 ? `${objects.length} selected` : isShapeLike ? (first.shapeType || first.iconName || 'Object') : 'Stroke'}
      </div>

      <div className="pp__row">
        <span className="pp__label">{isShapeLike ? 'Fill' : 'Color'}</span>
        <input
          type="color"
          className="pp__color"
          value={mixedColor ? '#000000' : first.color}
          onChange={(e) => onStyleChange({ color: e.target.value })}
          title={mixedColor ? 'Mixed — click to set one color' : first.color}
        />
      </div>

      {isText && (
        <>
          <div className="pp__row">
            <span className="pp__label">Font</span>
            <select className="pp__select" value={first.fontFamily || 'sans'} onChange={(e) => onStyleChange({ fontFamily: e.target.value })}>
              {FONT_OPTIONS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
          <div className="pp__row">
            <span className="pp__label">Size</span>
            <select className="pp__select" value={first.fontSize ?? 20} onChange={(e) => onStyleChange({ fontSize: parseInt(e.target.value, 10) })}>
              {FONT_SIZES.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
            </select>
          </div>
        </>
      )}
      {isText && objects.length === 1 && (
        <div className="pp__row">
          <span className="pp__label">Size</span>
          <input
            type="range" min="8" max="96" className="pp__range"
            value={first.fontSize ?? 20}
            onChange={(e) => onStyleChange({ fontSize: parseInt(e.target.value, 10) })}
          />
        </div>
      )}

      {isShapeLike && objects.length === 1 && (
        <>
          <div className="pp__row">
            <span className="pp__label">Rotation</span>
            <span className="pp__value">{degrees}°</span>
          </div>
          <div className="pp__row">
            <button
              type="button"
              className="pp__btn"
              title="Rotate 15°"
              onClick={() => onStyleChange({ rotation: (first.rotation ?? 0) + Math.PI / 12 })}
            >
              <RotateCw size={15} />
            </button>
          </div>
        </>
      )}

      <div className="pp__actions">
        <button type="button" className="pp__btn" title="Duplicate" onClick={onDuplicate}><Copy size={15} /></button>
        <button type="button" className="pp__btn pp__btn--danger" title="Delete" onClick={onDelete}><Trash2 size={15} /></button>
      </div>
    </div>
  );
}
