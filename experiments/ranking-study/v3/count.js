const fs = require('fs');
const path = require('path');
const dir = 'C:/Perso/IrishMusicExperiments/Cadence/experiments/ranking-study/.out';
const target = Number(process.argv[2] || 24000);
let n = 0, files = [], oldest = Infinity, newest = 0;
for (const f of fs.readdirSync(dir).filter(f => f.startsWith('' + (process.env.SEED_PREFIX || 'search-seed11-') + '') && !/-check|-dry/.test(f))) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
    n += a.length; files.push(`${f.slice(-7, -5)}:${a.length}`);
    const st = fs.statSync(path.join(dir, f));
    newest = Math.max(newest, st.mtimeMs);
  } catch { }
}
console.log(n, files.join(' '), new Date().toISOString());
