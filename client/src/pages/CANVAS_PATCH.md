# Canvas.jsx: board theme patch

Eight small edits. Everything else in `Canvas.jsx` stays as it is.

## 1. Import the themes (top of file)

```js
import { BOARD_THEMES, DEFAULT_THEME } from './boardThemes';
```

## 2. Remove the fixed selection colour

Delete this line:

```js
const SELECTION_COLOR = '#2563eb';
```

## 3. Accept two new props

```js
const Canvas = forwardRef(({ color = '#000000', brushSize = 5, roomId, ticket, canWrite = false,
  boardTheme = DEFAULT_THEME, onThemeChange,
  onCameraChange, onToolChange, onSelectionChange, onYjsClosed, onYjsConnected }, ref) => {
```

## 4. Add the theme refs (next to the other `...Ref = useRef(...)` lines)

```js
const themeRef = useRef(BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_THEME]);
themeRef.current = BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_THEME];
const onThemeChangeRef = useRef(onThemeChange);
onThemeChangeRef.current = onThemeChange;
```

Then, **below** the `scheduleRedraw` definition, add:

```js
useEffect(() => { scheduleRedraw(); }, [boardTheme]);
```

## 5. Use the theme's selection colour in `redrawAll`

At the very top of `redrawAll`, right after `const ctx = canvas.getContext('2d');`:

```js
const SEL = themeRef.current.selection;
```

Then replace **every** `SELECTION_COLOR` inside `redrawAll` with `SEL`. There are four: the dashed outlines, the frame box, the rotate-degrees label and the marquee stroke.

Also change the marquee fill:

```js
// before
ctx.fillStyle = 'rgba(37, 99, 235, 0.1)';
// after
ctx.fillStyle = `${SEL}1a`;
```

## 6. Sync the theme through Yjs, without wiping undo history

Your current `onMetaChange` clears everyone's undo history on *any* meta change (that is right for "clear board"). A theme change must not do that, so replace the whole handler:

```js
const readTheme = () => {
  const t = yMeta.get('theme');
  return Object.hasOwn(BOARD_THEMES, t) ? t : DEFAULT_THEME;
};
const onMetaChange = (event) => {
  if (event.keysChanged.has('theme')) onThemeChangeRef.current?.(readTheme());
  // a theme change on its own must not reset interactions or the undo stack
  if (event.keysChanged.size === 1 && event.keysChanged.has('theme')) return;
  interactionRef.current = null;
  // microtask: lets the UndoManager finish recording the clear transaction first, then wipe it
  queueMicrotask(() => undoManagerRef.current?.clear());
  scheduleRedraw();
};
yMeta.observe(onMetaChange);
```

## 7. Expose `setBoardTheme` (inside `useImperativeHandle`, e.g. after `resetView`)

```js
setBoardTheme: (key) => {
  if (!canWriteRef.current || !Object.hasOwn(BOARD_THEMES, key)) return;
  const ydoc = ydocRef.current;
  ydoc?.transact(() => ydoc.getMap('meta').set('theme', key));
},
```

## 8. Export PNG uses the board colour

In `exportPNG`:

```js
// before
ctx.fillStyle = '#fff';           // omit this line for a transparent background
// after
ctx.fillStyle = themeRef.current.board;
```

---

## Bug fix while you're in there

`addStroke` references `collapseTo`, which doesn't exist in that scope, so a view-only user triggering it throws a `ReferenceError`. Change:

```js
const addStroke = (s) => {
  if (!canWriteRef.current) {
    if (collapseTo) setSelection(new Set([collapseTo]));
    return;
  }
```

to:

```js
const addStroke = (s) => {
  if (!canWriteRef.current) return;
```
