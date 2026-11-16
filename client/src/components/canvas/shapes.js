const ngon = (n, r = 50) => {
  const o = [];
  for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; o.push(r * Math.cos(a), r * Math.sin(a)); }
  return o;
};
const star = () => {
  const o = [];
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (Math.PI * i) / 5, r = i % 2 ? 21 : 50; o.push(r * Math.cos(a), r * Math.sin(a)); }
  return o;
};
const rounded = (r = 16, steps = 6) => {
  const o = [];
  for (const [cx, cy, a0] of [[50 - r, -50 + r, -Math.PI / 2], [50 - r, 50 - r, 0], [-50 + r, 50 - r, Math.PI / 2], [-50 + r, -50 + r, Math.PI]])
    for (let i = 0; i <= steps; i++) { const a = a0 + (Math.PI / 2) * (i / steps); o.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return o;
};

export const SHAPE_BOUNDS = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
export const ICON_SIZE = 64;
export const ICON_BOUNDS = { minX: -32, minY: -32, maxX: 32, maxY: 32 };

export const SHAPES = {
  rect: { label: 'Rectangle', closed: true, points: [-50, -50, 50, -50, 50, 50, -50, 50] },
  rounded: { label: 'Rounded', closed: true, points: rounded() },
  circle: { label: 'Circle', closed: true, points: ngon(48) },
  triangle: { label: 'Triangle', closed: true, points: [0, -50, 50, 50, -50, 50] },
  diamond: { label: 'Diamond', closed: true, points: [0, -50, 50, 0, 0, 50, -50, 0] },
  pentagon: { label: 'Pentagon', closed: true, points: ngon(5) },
  hexagon: { label: 'Hexagon', closed: true, points: ngon(6) },
  star: { label: 'Star', closed: true, points: star() },
  arrow: { label: 'Arrow', closed: true, points: [-50, -15, 10, -15, 10, -35, 50, 0, 10, 35, 10, 15, -50, 15] }
};