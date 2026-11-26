'use strict';
// Where the benches read from. REPO: this repository. WS: the folder around it, where the benches'
// data and FolkFriend's fork sit beside it, outside the repository (transcription-bench/,
// folkfriend-src/); see ../README.md, « Benches ».
const path = require('node:path');
const REPO = path.resolve(__dirname, '../..').split(path.sep).join('/');
const WS = path.resolve(__dirname, '../../..').split(path.sep).join('/');
module.exports = { REPO, WS };
