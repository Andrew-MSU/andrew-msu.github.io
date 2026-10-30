/* Polygon split and auto-complete for simple lon/lat polygons.
   Distances are local equirectangular meters, which is plenty at this map scale. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabEdit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function lat0Of(coords) {
    var s = 0;
    for (var i = 0; i < coords.length; i++) s += coords[i][1];
    return s / coords.length;
  }

  function toM(lon, lat, lat0) {
    var cos = Math.cos(lat0 * Math.PI / 180);
    return [lon * 111320 * cos, lat * 110540];
  }

  function distM(a, b, lat0) {
    var A = toM(a[0], a[1], lat0);
    var B = toM(b[0], b[1], lat0);
    return Math.hypot(A[0] - B[0], A[1] - B[1]);
  }

  function ringArea(ring) {
    var lat0 = lat0Of(ring);
    var cos = Math.cos(lat0 * Math.PI / 180);
    var a = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var x1 = ring[i][0] * 111320 * cos;
      var y1 = ring[i][1] * 110540;
      var x2 = ring[i + 1][0] * 111320 * cos;
      var y2 = ring[i + 1][1] * 110540;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }

  function segHit(a, b, c, d, lat0) {
    var A = toM(a[0], a[1], lat0);
    var B = toM(b[0], b[1], lat0);
    var C = toM(c[0], c[1], lat0);
    var D = toM(d[0], d[1], lat0);
    var rx = B[0] - A[0];
    var ry = B[1] - A[1];
    var sx = D[0] - C[0];
    var sy = D[1] - C[1];
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-6) return null;
    var qpx = C[0] - A[0];
    var qpy = C[1] - A[1];
    var t = (qpx * sy - qpy * sx) / den;
    var u = (qpx * ry - qpy * rx) / den;
    if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
    t = Math.min(1, Math.max(0, t));
    u = Math.min(1, Math.max(0, u));
    return {
      point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      t: t,
      u: u
    };
  }

  function inRing(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0];
      var yi = ring[i][1];
      var xj = ring[j][0];
      var yj = ring[j][1];
      var intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-18) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function insideFeature(pt, feature) {
    var rings = feature.geometry.coordinates;
    if (!inRing(pt, rings[0])) return false;
    for (var h = 1; h < rings.length; h++) {
      if (inRing(pt, rings[h])) return false;
    }
    return true;
  }

  function centroid(ring) {
    var a = 0;
    var cx = 0;
    var cy = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var x1 = ring[i][0];
      var y1 = ring[i][1];
      var x2 = ring[i + 1][0];
      var y2 = ring[i + 1][1];
      var cross = x1 * y2 - x2 * y1;
      a += cross;
      cx += (x1 + x2) * cross;
      cy += (y1 + y2) * cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-18) return ring[0].slice();
    return [cx / (6 * a), cy / (6 * a)];
  }

  function clean(ring) {
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var p = ring[i];
      if (!out.length || distM(out[out.length - 1], p, p[1]) > 0.05) out.push(p.slice());
    }
    if (out.length && distM(out[0], out[out.length - 1], out[0][1]) > 0.05) out.push(out[0].slice());
    else if (out.length) out[out.length - 1] = out[0].slice();
    if (out.length < 4) return null;
    return out;
  }

  function selfIntersects(ring) {
    var n = ring.length - 1;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (Math.abs(i - j) <= 1) continue;
        if (i === 0 && j === n - 1) continue;
        var hit = segHit(ring[i], ring[i + 1], ring[j], ring[j + 1], ring[i][1]);
        if (!hit) continue;
        /* Ignore a touch exactly at a shared vertex. */
        if (hit.t > 0.002 && hit.t < 0.998 && hit.u > 0.002 && hit.u < 0.998) return true;
      }
    }
    return false;
  }

  function lineHits(ring, line) {
    var lat0 = lat0Of(ring);
    var hits = [];
    var along = [0];
    for (var s = 0; s < line.length - 1; s++) along.push(along[s] + distM(line[s], line[s + 1], lat0));
    for (var seg = 0; seg < line.length - 1; seg++) {
      for (var e = 0; e < ring.length - 1; e++) {
        var hit = segHit(line[seg], line[seg + 1], ring[e], ring[e + 1], lat0);
        if (!hit) continue;
        hits.push({
          point: hit.point,
          edge: e,
          u: hit.u,
          seg: seg,
          t: hit.t,
          dist: along[seg] + hit.t * (along[seg + 1] - along[seg])
        });
      }
    }
    hits.sort(function (a, b) { return a.dist - b.dist; });
    var unique = [];
    for (var i = 0; i < hits.length; i++) {
      if (!unique.length || distM(unique[unique.length - 1].point, hits[i].point, lat0) > 1.5) unique.push(hits[i]);
    }
    return unique;
  }

  function sliceLine(line, a, b) {
    var out = [a.point.slice()];
    if (a.seg === b.seg) {
      out.push(b.point.slice());
      return out;
    }
    for (var s = a.seg; s < b.seg; s++) out.push(line[s + 1].slice());
    out.push(b.point.slice());
    return out;
  }

  function chainForward(ring, fromEdge, fromPt, toEdge, toPt) {
    var n = ring.length - 1;
    var out = [fromPt.slice()];
    if (fromEdge === toEdge) {
      out.push(toPt.slice());
      return out;
    }
    var k = (fromEdge + 1) % n;
    for (var guard = 0; guard <= n + 1; guard++) {
      out.push(ring[k].slice());
      if (k === toEdge) {
        out.push(toPt.slice());
        return out;
      }
      k = (k + 1) % n;
    }
    return null;
  }

  function chainBackward(ring, fromEdge, fromPt, toEdge, toPt) {
    var n = ring.length - 1;
    var out = [fromPt.slice()];
    var k = fromEdge;
    var stopAt = (toEdge + 1) % n;
    for (var guard = 0; guard <= n + 2; guard++) {
      out.push(ring[k].slice());
      if (k === stopAt) {
        out.push(toPt.slice());
        return out;
      }
      k = (k - 1 + n) % n;
    }
    return null;
  }

  function closeWith(sketch, chain) {
    var rev = chain.slice().reverse();
    var ring = sketch.map(function (p) { return p.slice(); });
    for (var i = 1; i < rev.length - 1; i++) ring.push(rev[i].slice());
    var cleaned = clean(ring.concat([ring[0].slice()]));
    return cleaned;
  }

  function pointAlong(line, a, b) {
    var sliced = sliceLine(line, a, b);
    if (sliced.length === 2) {
      return [(sliced[0][0] + sliced[1][0]) / 2, (sliced[0][1] + sliced[1][1]) / 2];
    }
    var mid = sliced[Math.floor(sliced.length / 2)];
    return mid.slice();
  }

  function splitPolygon(feature, line) {
    if (!feature || feature.geometry.type !== "Polygon") return { error: "Choose a polygon to split." };
    if (feature.geometry.coordinates.length > 1) {
      return { error: "This practice split works on a polygon without holes. Use the outlined one." };
    }
    if (!line || line.length < 2) return { error: "Draw at least two vertices." };
    var ring = feature.geometry.coordinates[0];
    var hits = lineHits(ring, line);
    if (hits.length < 2) {
      return { error: "The line has to enter and leave the outlined polygon. Start outside it and finish outside it." };
    }
    if (hits.length > 2) {
      return { error: "The line crosses the outline more than twice. Draw one clean cut." };
    }
    var mid = pointAlong(line, hits[0], hits[1]);
    if (!inRing(mid, ring)) {
      return { error: "That line does not pass through the inside of the polygon." };
    }
    var sketch = sliceLine(line, hits[0], hits[1]);
    var forward = chainForward(ring, hits[0].edge, hits[0].point, hits[1].edge, hits[1].point);
    var backward = chainBackward(ring, hits[0].edge, hits[0].point, hits[1].edge, hits[1].point);
    if (!forward || !backward) return { error: "Could not follow the polygon outline. Try a simpler line." };
    var ringA = closeWith(sketch, forward);
    var ringB = closeWith(sketch, backward);
    if (!ringA || !ringB) return { error: "The cut did not produce two polygons. Cross more of the shape." };
    if (selfIntersects(ringA) || selfIntersects(ringB)) {
      return { error: "That cut makes a tangled shape. Undo a vertex and cross the polygon once." };
    }
    var area0 = ringArea(ring);
    var areaA = ringArea(ringA);
    var areaB = ringArea(ringB);
    if (areaA < area0 * 0.04 || areaB < area0 * 0.04) {
      return { error: "One piece is only a sliver. Draw the line farther across the polygon." };
    }
    if (Math.abs(areaA + areaB - area0) / area0 > 0.08) {
      return { error: "The two pieces do not add up to the original polygon. Try the cut again." };
    }
    return { rings: [ringA, ringB], areas: [areaA, areaB] };
  }

  function project(pt, a, b, lat0) {
    var P = toM(pt[0], pt[1], lat0);
    var A = toM(a[0], a[1], lat0);
    var B = toM(b[0], b[1], lat0);
    var vx = B[0] - A[0];
    var vy = B[1] - A[1];
    var len2 = vx * vx + vy * vy;
    if (len2 < 1e-8) return null;
    var t = ((P[0] - A[0]) * vx + (P[1] - A[1]) * vy) / len2;
    t = Math.min(1, Math.max(0, t));
    var point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    return { point: point, dist: distM(pt, point, lat0), t: t };
  }

  function snapPoint(pt, features, tolM) {
    var best = null;
    for (var f = 0; f < features.length; f++) {
      var feature = features[f];
      var rings = feature.geometry.coordinates;
      for (var r = 0; r < rings.length; r++) {
        var ring = rings[r];
        for (var i = 0; i < ring.length - 1; i++) {
          var hit = project(pt, ring[i], ring[i + 1], pt[1]);
          if (!hit || hit.dist > tolM) continue;
          if (!best || hit.dist < best.dist) {
            best = {
              dist: hit.dist,
              point: hit.point,
              edge: i,
              ringIndex: r,
              feature: feature,
              ring: ring
            };
          }
        }
      }
    }
    return best;
  }

  function sharesBoundary(ring, feature) {
    var rings = feature.geometry.coordinates;
    for (var r = 0; r < rings.length; r++) {
      var old = rings[r];
      var verts = new Set(old.map(function (p) { return p[0].toFixed(5) + "," + p[1].toFixed(5); }));
      var shared = 0;
      for (var i = 0; i < ring.length - 1; i++) {
        var key = ring[i][0].toFixed(5) + "," + ring[i][1].toFixed(5);
        if (verts.has(key)) shared++;
      }
      if (shared >= 2) return true;
      for (var e = 0; e < old.length - 1; e++) {
        for (var k = 0; k < ring.length - 1; k++) {
          var d1 = project(ring[k], old[e], old[e + 1], old[e][1]);
          var d2 = project(ring[k + 1], old[e], old[e + 1], old[e][1]);
          if (d1 && d2 && d1.dist < 1.2 && d2.dist < 1.2 && distM(ring[k], ring[k + 1], old[e][1]) > 25) return true;
        }
      }
    }
    return false;
  }

  function autoComplete(features, line, tolM) {
    if (!line || line.length < 2) return { error: "Draw at least two vertices." };
    var start = snapPoint(line[0], features, tolM);
    var end = snapPoint(line[line.length - 1], features, tolM);
    if (!start || !end) {
      return { error: "Both ends of the line need to touch an existing polygon. Zoom in and place the ends on an outline. Snap distance right now is about " + Math.round(tolM) + " m." };
    }
    if (start.feature !== end.feature || start.ringIndex !== end.ringIndex) {
      return { error: "Both ends need to touch the same polygon. ArcGIS Pro can follow several neighbors; this practice closes against one." };
    }
    var sketch = line.map(function (p) { return p.slice(); });
    sketch[0] = start.point.slice();
    sketch[sketch.length - 1] = end.point.slice();
    var ring = start.ring;
    var forward = chainForward(ring, start.edge, start.point, end.edge, end.point);
    var backward = chainBackward(ring, start.edge, start.point, end.edge, end.point);
    if (!forward || !backward) return { error: "Could not follow that outline. Try ends that sit on a clearer edge." };
    var candidates = [closeWith(sketch, forward), closeWith(sketch, backward)].filter(Boolean);
    if (!candidates.length) return { error: "That line did not close a polygon." };
    var ranked = candidates.map(function (coords) {
      return { ring: coords, area: ringArea(coords) };
    }).filter(function (c) {
      return c.area > 8000 && c.area < 8e6 && !selfIntersects(c.ring) && sharesBoundary(c.ring, start.feature);
    });
    ranked.sort(function (a, b) { return a.area - b.area; });
    if (!ranked.length) return { error: "That outline crosses itself, misses the shared edge, or is too small. Undo a point and bow the line into an empty patch." };
    return {
      ring: ranked[0].ring,
      area: ranked[0].area,
      attachedId: start.feature.properties.id,
      attachedFormation: start.feature.properties.formation,
      attachedUnit: start.feature.properties.unit,
      options: ranked
    };
  }

  return {
    splitPolygon: splitPolygon,
    autoComplete: autoComplete,
    insideFeature: insideFeature,
    ringArea: ringArea,
    sharesBoundary: sharesBoundary
  };
});
