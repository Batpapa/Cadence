const fs = require("fs"); const path = require("path");
const V = __dirname, B = path.join(V, "e5-backup-before-perT");
let files = 0, bad = 0, withPerT = 0;
for (const f of fs.readdirSync(B)) {
  const a = JSON.parse(fs.readFileSync(path.join(B, f), "utf-8"));
  const b = JSON.parse(fs.readFileSync(path.join(V, f), "utf-8"));
  files++;
  if (a.length !== b.length) { bad++; console.log("LONGUEUR", f); continue; }
  for (let i = 0; i < a.length; i++) {
    const k = r => JSON.stringify([r.label, r.found, r.fp, r.noise, r.coverage, r.per, r.temporal]);
    if (k(a[i]) !== k(b[i])) { bad++; console.log("DIFF", f, a[i].label); }
    if (Array.isArray(b[i].perT) && b[i].perT.length === 7) withPerT++;
  }
}
console.log(files + " fichiers compares, " + bad + " differences, " + withPerT + " lignes avec perT");
