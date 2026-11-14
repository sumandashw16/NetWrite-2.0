import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// y-websocket/bin/utils is CommonJS and loads yjs's CJS build.
// Load the same build here so the whole server uses one copy of Yjs.
const Y = require('yjs');

export default Y;