// Floor-sweep curves for the report chart: found / fp / IoU per floor, three arms.
const fs = require("fs"); const path = require("path");
const arms = { "Production actuelle": "ctl", "Tempo 200 + porte": "t200L20", "Tempo 180 + présélection 4 000 + porte": "t180-rep4000L20" };
const out = {};
for (const [label, arm] of Object.entries(arms)) {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "e5-floors-" + arm + ".json"), "utf-8"));
  out[label] = rows.map(r => ({ floor: +r.floor.toFixed(2), found: r.found, fp: r.fp, iou: +(100 * r.temporal.iouMean).toFixed(1) }));
}
fs.writeFileSync(path.join(__dirname, "chart-data.json"), JSON.stringify(out));
console.log(JSON.stringify(out));
