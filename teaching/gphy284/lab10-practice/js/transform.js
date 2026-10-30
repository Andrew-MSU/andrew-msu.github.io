/* Polynomial georeferencing in the browser.
   1st order is an affine fit. 2nd order adds quadratic terms.
   Source pixels are normalized before the least-squares solve. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabTransform = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function solve(matrix, vector) {
    var n = matrix.length;
    var m = matrix.map(function (row, i) { return row.concat([vector[i]]); });
    for (var col = 0; col < n; col++) {
      var pivot = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      }
      if (Math.abs(m[pivot][col]) < 1e-12) return null;
      var tmp = m[col];
      m[col] = m[pivot];
      m[pivot] = tmp;
      var div = m[col][col];
      for (var c = col; c <= n; c++) m[col][c] /= div;
      for (var rr = 0; rr < n; rr++) {
        if (rr === col) continue;
        var factor = m[rr][col];
        if (factor === 0) continue;
        for (var cc = col; cc <= n; cc++) m[rr][cc] -= factor * m[col][cc];
      }
    }
    return m.map(function (row) { return row[n]; });
  }

  function leastSquares(rows, values) {
    var cols = rows[0].length;
    var ata = [];
    var atb = [];
    for (var r = 0; r < cols; r++) {
      ata.push(new Array(cols).fill(0));
      atb.push(0);
    }
    for (var i = 0; i < rows.length; i++) {
      for (var r2 = 0; r2 < cols; r2++) {
        atb[r2] += rows[i][r2] * values[i];
        for (var c2 = 0; c2 < cols; c2++) ata[r2][c2] += rows[i][r2] * rows[i][c2];
      }
    }
    return solve(ata, atb);
  }

  function basis(u, v, order) {
    if (order === 1) return [1, u, v];
    return [1, u, v, u * u, u * v, v * v];
  }

  function minPoints(order) {
    return order === 1 ? 3 : 6;
  }

  /* points: [{x, y, lon, lat}] in image pixels and WGS84 degrees. */
  function fit(points, order) {
    if (!points || points.length < minPoints(order)) return null;
    var n = points.length;
    var mx = 0;
    var my = 0;
    var mlon = 0;
    var mlat = 0;
    for (var i = 0; i < n; i++) {
      mx += points[i].x;
      my += points[i].y;
      mlon += points[i].lon;
      mlat += points[i].lat;
    }
    mx /= n;
    my /= n;
    mlon /= n;
    mlat /= n;
    var scale = 1;
    for (var j = 0; j < n; j++) {
      scale = Math.max(scale, Math.abs(points[j].x - mx), Math.abs(points[j].y - my));
    }
    var rows = [];
    var lonV = [];
    var latV = [];
    for (var k = 0; k < n; k++) {
      var u = (points[k].x - mx) / scale;
      var v = (points[k].y - my) / scale;
      rows.push(basis(u, v, order));
      lonV.push(points[k].lon - mlon);
      latV.push(points[k].lat - mlat);
    }
    var lonC = leastSquares(rows, lonV);
    var latC = leastSquares(rows, latV);
    if (!lonC || !latC) return null;
    return {
      order: order,
      mx: mx,
      my: my,
      scale: scale,
      mlon: mlon,
      mlat: mlat,
      lonC: lonC,
      latC: latC
    };
  }

  function evalModel(model, x, y) {
    var u = (x - model.mx) / model.scale;
    var v = (y - model.my) / model.scale;
    var b = basis(u, v, model.order);
    var lon = model.mlon;
    var lat = model.mlat;
    for (var i = 0; i < b.length; i++) {
      lon += model.lonC[i] * b[i];
      lat += model.latC[i] * b[i];
    }
    return [lon, lat];
  }

  function jacobian(model, u, v) {
    var lx = model.lonC;
    var ly = model.latC;
    if (model.order === 1) {
      return [lx[1], lx[2], ly[1], ly[2]];
    }
    return [
      lx[1] + 2 * lx[3] * u + lx[4] * v,
      lx[2] + lx[4] * u + 2 * lx[5] * v,
      ly[1] + 2 * ly[3] * u + ly[4] * v,
      ly[2] + ly[4] * u + 2 * ly[5] * v
    ];
  }

  /* Inverse: geographic coordinate to image pixel. Newton for order 2. */
  function invert(model, lon, lat) {
    var u = 0;
    var v = 0;
    for (var iter = 0; iter < 12; iter++) {
      var x = model.mx + u * model.scale;
      var y = model.my + v * model.scale;
      var pred = evalModel(model, x, y);
      var dlon = lon - pred[0];
      var dlat = lat - pred[1];
      if (Math.abs(dlon) + Math.abs(dlat) < 1e-12) break;
      var j = jacobian(model, u, v);
      var det = j[0] * j[3] - j[1] * j[2];
      if (Math.abs(det) < 1e-14) return null;
      var du = (dlon * j[3] - dlat * j[1]) / det;
      var dv = (j[0] * dlat - j[2] * dlon) / det;
      u += du;
      v += dv;
      if (Math.abs(du) + Math.abs(dv) < 1e-10) break;
    }
    return [model.mx + u * model.scale, model.my + v * model.scale];
  }

  function meters(lon1, lat1, lon2, lat2) {
    var r = 6371000;
    var p = Math.PI / 180;
    var dlat = (lat2 - lat1) * p;
    var dlon = (lon2 - lon1) * p;
    var a = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
      Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function residuals(model, points) {
    var rows = [];
    var sum = 0;
    for (var i = 0; i < points.length; i++) {
      var pred = evalModel(model, points[i].x, points[i].y);
      var d = meters(pred[0], pred[1], points[i].lon, points[i].lat);
      rows.push(d);
      sum += d * d;
    }
    return {
      each: rows,
      rms: Math.sqrt(sum / points.length)
    };
  }

  /* How far the two models disagree inside the image, in meters. */
  function maxGap(a, b, width, height) {
    var worst = 0;
    for (var iy = 0; iy <= 4; iy++) {
      for (var ix = 0; ix <= 4; ix++) {
        var x = (width * ix) / 4;
        var y = (height * iy) / 4;
        var pa = evalModel(a, x, y);
        var pb = evalModel(b, x, y);
        worst = Math.max(worst, meters(pa[0], pa[1], pb[0], pb[1]));
      }
    }
    return worst;
  }

  return {
    fit: fit,
    apply: evalModel,
    invert: invert,
    residuals: residuals,
    meters: meters,
    maxGap: maxGap,
    minPoints: minPoints
  };
});
