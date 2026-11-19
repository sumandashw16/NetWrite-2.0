// Board themes. Keep every `pen` and palette entry as a lowercase 6-digit hex
// (the <input type="color"> in the toolbar needs that format).

export const DEFAULT_THEME = 'chalkboard';

export const BOARD_THEMES = {
  chalkboard: {
    label: 'Chalkboard',
    board: '#3c4f35',                 // school-board olive green
    dot: 'rgba(255, 255, 255, 0.07)',
    vignette: 'rgba(0, 0, 0, 0.38)',
    pen: '#f4f1e8',                   // white chalk
    selection: '#fcd34d',             // chalk yellow, blue is unreadable on green
    palette: ['#f4f1e8', '#fde68a', '#fda4af', '#93c5fd', '#86efac']
  },
  blackboard: {
    label: 'Blackboard',
    board: '#101114',
    dot: 'rgba(255, 255, 255, 0.06)',
    vignette: 'rgba(0, 0, 0, 0.5)',
    pen: '#f4f4f5',
    selection: '#60a5fa',
    palette: ['#f4f4f5', '#fde68a', '#fda4af', '#93c5fd', '#86efac']
  },
  whiteboard: {
    label: 'Whiteboard',
    board: '#f7f8fa',
    dot: 'rgba(17, 24, 39, 0.10)',
    vignette: 'rgba(17, 24, 39, 0.10)',
    pen: '#111827',
    selection: '#2563eb',
    palette: ['#111827', '#dc2626', '#2563eb', '#16a34a', '#d97706']
  }
};

// True when `color` is one of the built-in default pens, i.e. the user never picked a custom colour.
export const isDefaultPen = (color) =>
  Object.values(BOARD_THEMES).some((t) => t.pen === String(color).toLowerCase());
