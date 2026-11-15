import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
const URL = 'ws://localhost:5000/yjs/guard-test';
const GOOD = { Origin: 'http://localhost:5173' };

function run(name, headers, send) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers });
    ws.on('error', (e) => console.log(`${name}: error event (${e.message})`));
    ws.on('open', () => send?.(ws));
    ws.on('close', (code) => { console.log(`${name}: closed (${code})`); resolve(); });
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) { console.log(`${name}: STILL OPEN`); ws.close(); }
      resolve();
    }, 3000);
  });
}
function evilUpdate() {
  const doc = new Y.Doc();
  const m = new Y.Map();
  m.set('id', 'evil');
  m.set('points', [1, 2]);
  m.set('color', 'javascript:alert(1)');   // fails the color check
  doc.getMap('strokes').set('evil', m);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);           // sync message
  encoding.writeVarUint(enc, 2);           // update
  encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc));
  return encoding.toUint8Array(enc);
}


await run('1 oversize   (expect 1009)', GOOD, (ws) => ws.send(Buffer.alloc(200 * 1024)));
await run('2 flood (valid msgs, expect 1006)', GOOD, (ws) => {
  for (let i = 0; i < 2000; i++) ws.send(Buffer.from([0, 0, 1, 0]));
});
await run('3 garbage (expect 1006)', GOOD, (ws) => ws.send(Buffer.from([0, 2, 255, 255, 255, 255])));
await run('4 bad origin (expect error/refused)', { Origin: 'http://evil.example' });
await run('5 bad stroke (expect 1006)', GOOD, (ws) => ws.send(evilUpdate()));
process.exit(0);