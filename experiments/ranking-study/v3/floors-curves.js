// Floor-sweep curves per arm: found / fp / IoU at each floor, and the Pareto
// comparison "best recall at fp <= budget" across arms.
//   node experiments/ranking-study/v3/floors-curves.js arm1 arm2 ...   (reads v3/e5-floors-<arm>.json)
const fs = require("fs");
const path = require("path");
const arms = process.argv.slice(2);
const data = arms.map(a => ({ a, rows: JSON.parse(fs.readFileSync(path.join(__dirname, "e5-floors-" + a + ".json"), "utf-8")) }));
console.log("plancher  " + arms.map(a => a.padStart(24)).join(""));
for (let i = 0; i < data[0].rows.length; i++) {
  const fl = data[0].rows[i].floor.toFixed(2);
  console.log(("  " + fl).padEnd(10) + data.map(d => { const r = d.rows[i]; return (r.found + "/" + r.fp + " " + (100 * r.temporal.iouMean).toFixed(1) + "%").padStart(24); }).join(""));
}
console.log("\nmeilleur rappel a fp <= budget (IoU du point retenu), sur le balayage");
for (const B of [5, 8, 10, 12, 15, 20]) {
  console.log(("  fp<=" + B).padEnd(10) + data.map(d => {
    const ok = d.rows.filter(r => r.fp <= B);
    if (!ok.length) return "-".padStart(24);
    const best = ok.sort((x, y) => y.found - x.found || x.fp - y.fp)[0];
    return (best.found + "/" + best.fp + " " + (100 * best.temporal.iouMean).toFixed(1) + "% @" + best.floor.toFixed(2)).padStart(24);
  }).join(""));
}
