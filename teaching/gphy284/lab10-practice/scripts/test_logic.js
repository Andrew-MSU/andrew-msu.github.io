const assert = require("assert");
const T = require("../js/transform");
const SQL = require("../js/sql");
const E = require("../js/editgeom");

function near(a, b, tol) {
  assert.ok(Math.abs(a - b) <= tol, a + " vs " + b);
}

/* Affine fit recovers a known plane from four points. */
(function () {
  const pts = [
    { x: 0, y: 0, lon: 10, lat: 20 },
    { x: 100, y: 0, lon: 12, lat: 21 },
    { x: 0, y: 50, lon: 11, lat: 23 },
    { x: 100, y: 50, lon: 13, lat: 24 }
  ];
  const model = T.fit(pts, 1);
  const pred = T.apply(model, 100, 50);
  near(pred[0], 13, 1e-8);
  near(pred[1], 24, 1e-8);
  const back = T.invert(model, 13, 24);
  near(back[0], 100, 1e-4);
  near(back[1], 50, 1e-4);
  const res = T.residuals(model, pts);
  assert.ok(res.rms < 1e-3, "rms " + res.rms);
})();

/* Second order matches a quadratic and inverts it. */
(function () {
  const pts = [];
  for (let x = 0; x <= 100; x += 50) {
    for (let y = 0; y <= 100; y += 50) {
      pts.push({ x, y, lon: 10 + 0.01 * x + 0.00002 * x * y, lat: 45 + 0.01 * y });
    }
  }
  const model = T.fit(pts, 2);
  assert.ok(model, "order 2 fit");
  const pred = T.apply(model, 25, 75);
  const expectLon = 10 + 0.01 * 25 + 0.00002 * 25 * 75;
  near(pred[0], expectLon, 1e-8);
  const back = T.invert(model, pred[0], pred[1]);
  near(back[0], 25, 1e-3);
  near(back[1], 75, 1e-3);
})();

(function () {
  const rows = [
    { Contour: 2000, Type: "" },
    { Contour: 2020, Type: "" },
    { Contour: 2100, Type: "index" },
    { Contour: 1980, Type: "intermediate" }
  ];
  function select(text) {
    const fn = SQL.compile(text);
    return rows.filter(fn).map((r) => r.Contour);
  }
  assert.deepStrictEqual(select("MOD(Contour, 100) = 0"), [2000, 2100]);
  assert.deepStrictEqual(select("Contour = 2020"), [2020]);
  assert.deepStrictEqual(select('"Contour" >= 2000 AND MOD(Contour, 100) = 0'), [2000, 2100]);
  assert.deepStrictEqual(select("Contour = 2000 OR Contour = 1980"), [2000, 1980]);
  assert.deepStrictEqual(select("(Contour > 2090 AND Contour < 2110) OR Contour = 1980"), [2100, 1980]);
  assert.deepStrictEqual(select("Type = 'index'"), [2100]);
  assert.deepStrictEqual(select("NOT MOD(Contour, 100) = 0"), [2020, 1980]);
  assert.throws(() => SQL.compile("Contour = 1; DROP TABLE"), /character|rest/i);
  assert.throws(() => SQL.compile("Foo = 1"), /Unknown field/);
  assert.throws(() => SQL.compile("MOD(Contour, 0) = 0"), /zero/);
})();

function square() {
  return {
    type: "Feature",
    properties: { id: 1, formation: "Granodiorite", unit: "Kgd" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }
  };
}

(function () {
  const poly = square();
  const cut = E.splitPolygon(poly, [[-0.2, 0.5], [1.2, 0.5]]);
  assert.ok(!cut.error, cut.error);
  assert.strictEqual(cut.rings.length, 2);
  const areas = cut.areas.reduce((s, a) => s + a, 0);
  near(areas, E.ringArea(poly.geometry.coordinates[0]), areas * 0.02);
  cut.rings.forEach((ring) => {
    assert.ok(ring.length >= 4);
    assert.deepStrictEqual(ring[0], ring[ring.length - 1]);
  });
})();

(function () {
  const x0 = -112.58;
  const y0 = 45.53;
  const s = 0.01;
  const poly = {
    type: "Feature",
    properties: { id: 1, formation: "Granodiorite", unit: "Kgd" },
    geometry: {
      type: "Polygon",
      coordinates: [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]]
    }
  };
  const outside = E.autoComplete(
    [poly],
    [[x0 + 0.002, y0], [x0 + 0.002, y0 - 0.004], [x0 + 0.008, y0 - 0.004], [x0 + 0.008, y0]],
    80
  );
  assert.ok(!outside.error, outside.error);
  assert.ok(outside.area > 0);
  assert.strictEqual(outside.attachedFormation, "Granodiorite");
  assert.ok(E.sharesBoundary(outside.ring, poly));
  assert.ok(!E.insideFeature([x0 + 0.005, y0 - 0.002], poly));
})();

(function () {
  const dms = (d, m, s, sign) => sign * (d + m / 60 + s / 3600);
  near(dms(45, 32, 16, 1), 45.5377777778, 1e-9);
  near(dms(112, 36, 48, -1), -112.6133333333, 1e-9);
  near(dms(45, 33, 51, 1), 45.5641666667, 1e-9);
  near(dms(112, 34, 5, -1), -112.5680555556, 1e-9);
})();

console.log("logic tests passed");
