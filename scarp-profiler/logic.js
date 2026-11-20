/* Scarp measurement geometry. No network and no DOM.
   Throw is the vertical separation of the fitted footwall and hanging-wall
   surfaces, measured at the midpoint of the scarp face. Heave = throw / tan(dip),
   net slip = throw / sin(dip). Distances are meters. Bearings are degrees
   clockwise from north. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScarpLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  var EARTH = 6371000;
  var M_PER_DEG_LAT = 111132;

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  function haversine(a, b) {
    var φ1 = toRad(a.lat);
    var φ2 = toRad(b.lat);
    var dφ = toRad(b.lat - a.lat);
    var dλ = toRad(b.lng - a.lng);
    var h = Math.sin(dφ / 2) * Math.sin(dφ / 2)
      + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) * Math.sin(dλ / 2);
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    var φ1 = toRad(a.lat);
    var φ2 = toRad(b.lat);
    var dλ = toRad(b.lng - a.lng);
    var y = Math.sin(dλ) * Math.cos(φ2);
    var x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function destination(origin, bearingDeg, distM) {
    var δ = distM / EARTH;
    var θ = toRad(bearingDeg);
    var φ1 = toRad(origin.lat);
    var λ1 = toRad(origin.lng);
    var φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    var λ2 = λ1 + Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
    return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
  }

  function midpoint(a, b) {
    return destination(a, bearing(a, b), haversine(a, b) / 2);
  }

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function mPerDegLng(lat) {
    return 111320 * Math.cos(toRad(lat));
  }

  /* Closest point on segment AB to P, in local meters. */
  function projectPointToSegment(p, a, b) {
    var mLng = mPerDegLng(p.lat);
    var px = (p.lng - a.lng) * mLng;
    var py = (p.lat - a.lat) * M_PER_DEG_LAT;
    var bx = (b.lng - a.lng) * mLng;
    var by = (b.lat - a.lat) * M_PER_DEG_LAT;
    var len2 = bx * bx + by * by;
    var t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var x = t * bx;
    var y = t * by;
    return {
      point: {
        lng: a.lng + (b.lng - a.lng) * t,
        lat: a.lat + (b.lat - a.lat) * t
      },
      dist: Math.hypot(px - x, py - y),
      t: t
    };
  }

  /* parts: array of [lng, lat] rings (LineString or MultiLineString). */
  function nearestOnLine(latlng, parts) {
    var best = null;
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p];
      for (var i = 0; i < part.length - 1; i++) {
        var a = { lng: part[i][0], lat: part[i][1] };
        var b = { lng: part[i + 1][0], lat: part[i + 1][1] };
        if (!isFinite(a.lat) || !isFinite(b.lat)) continue;
        var proj = projectPointToSegment(latlng, a, b);
        if (!best || proj.dist < best.dist) {
          best = {
            point: proj.point,
            dist: proj.dist,
            a: a,
            b: b,
            bearing: bearing(a, b)
          };
        }
      }
    }
    return best;
  }

  var ROSE = {
    n: 0, nne: 22.5, ne: 45, ene: 67.5, e: 90, ese: 112.5, se: 135, sse: 157.5,
    s: 180, ssw: 202.5, sw: 225, wsw: 247.5, w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
    north: 0, south: 180, east: 90, west: 270
  };

  function dipBearing(text) {
    if (!text) return null;
    var key = String(text).trim().toLowerCase().replace(/[^a-z]/g, '');
    return Object.prototype.hasOwnProperty.call(ROSE, key) ? ROSE[key] : null;
  }

  /* Hanging wall is the perpendicular closest to the mapped dip direction. */
  function chooseHangingBearing(segmentBearing, dipDirection) {
    var seg = (segmentBearing % 360 + 360) % 360;
    var perpA = (seg + 90) % 360;
    var perpB = (seg + 270) % 360;
    var dip = dipBearing(dipDirection);
    var hanging = perpA;
    if (dip != null && angleDiff(perpB, dip) < angleDiff(perpA, dip)) hanging = perpB;
    return {
      hanging: hanging,
      footwall: (hanging + 180) % 360,
      usedDip: dip != null
    };
  }

  /* Left/right of a directed strike, looking from the first click toward the second. */
  function sideBearing(strikeBearing, side) {
    var seg = (strikeBearing % 360 + 360) % 360;
    return side === 'right' ? (seg + 90) % 360 : (seg + 270) % 360;
  }

  /* Profile of lengthM centered on origin, footwall end first. */
  function perpendicularProfile(origin, footwallBearing, hangingBearing, lengthM) {
    var half = lengthM / 2;
    return {
      start: destination(origin, footwallBearing, half),
      end: destination(origin, hangingBearing, half)
    };
  }

  function pathLength(vertices) {
    var d = 0;
    for (var i = 1; i < vertices.length; i++) d += haversine(vertices[i - 1], vertices[i]);
    return d;
  }

  /* Drawn vertices, or the stored start and end when an older profile has none. */
  function verticesOf(profile) {
    if (profile && profile.vertices && profile.vertices.length >= 2) {
      return profile.vertices.map(function (v) { return { lat: v.lat, lng: v.lng }; });
    }
    if (profile && profile.start && profile.end) {
      return [
        { lat: profile.start.lat, lng: profile.start.lng },
        { lat: profile.end.lat, lng: profile.end.lng }
      ];
    }
    return [];
  }

  function pointAtDistance(vertices, dist) {
    var walked = 0;
    for (var i = 1; i < vertices.length; i++) {
      var len = haversine(vertices[i - 1], vertices[i]);
      if (walked + len >= dist || i === vertices.length - 1) {
        var along = len > 0 ? (dist - walked) / len : 0;
        if (along < 0) along = 0;
        if (along > 1) along = 1;
        return destination(vertices[i - 1], bearing(vertices[i - 1], vertices[i]), along * len);
      }
      walked += len;
    }
    var last = vertices[vertices.length - 1];
    return { lat: last.lat, lng: last.lng };
  }

  /* Drop elevation samples onto the profile path. Distance is chainage from the first vertex. */
  function projectSamples(raw, vertices) {
    if (!vertices || vertices.length < 2) return [];
    var segs = [];
    var cum = 0;
    for (var i = 1; i < vertices.length; i++) {
      var len = haversine(vertices[i - 1], vertices[i]);
      segs.push({ a: vertices[i - 1], b: vertices[i], d0: cum, len: len });
      cum += len;
    }
    var total = cum;
    var out = [];
    for (var r = 0; r < raw.length; r++) {
      var p = raw[r];
      if (!isFinite(p.z) || p.z < -200 || p.z > 9000) continue;
      var best = null;
      for (var s = 0; s < segs.length; s++) {
        var seg = segs[s];
        if (seg.len < 0.05) continue;
        var proj = projectPointToSegment(p, seg.a, seg.b);
        if (!best || proj.dist < best.dist) {
          best = { dist: proj.dist, d: seg.d0 + seg.len * proj.t };
        }
      }
      if (!best || best.dist > 40) continue;
      var d = best.d;
      if (d < 0) d = 0;
      if (d > total) d = total;
      out.push({
        lat: p.lat,
        lng: p.lng,
        z: p.z,
        d: d,
        resolution: isFinite(p.resolution) ? p.resolution : null
      });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    return out;
  }

  function downsample(samples, spacingM) {
    if (!samples.length) return [];
    var spacing = Math.max(0.5, spacingM || 2);
    var out = [samples[0]];
    var last = samples[0].d;
    for (var i = 1; i < samples.length - 1; i++) {
      if (samples[i].d - last >= spacing) {
        out.push(samples[i]);
        last = samples[i].d;
      }
    }
    var tail = samples[samples.length - 1];
    if (out[out.length - 1] !== tail) out.push(tail);
    return out;
  }

  function resolutionNote(samples) {
    var rs = [];
    for (var i = 0; i < samples.length; i++) {
      var r = samples[i].resolution;
      if (r > 0) rs.push(r);
    }
    if (!rs.length) return '';
    rs.sort(function (a, b) { return a - b; });
    var mid = rs[Math.floor(rs.length / 2)];
    if (mid > 0.00005 && mid < 0.02) {
      return 'Source spacing about ' + Math.round(mid * 111320) + ' m';
    }
    if (mid <= 3) return 'Lidar-scale source (about ' + mid.toFixed(1) + ' m)';
    return 'Source resolution about ' + Math.round(mid) + ' m';
  }

  function pointsInRange(samples, range) {
    if (!range || !isFinite(range.x0) || !isFinite(range.x1)) return [];
    var a = Math.min(range.x0, range.x1);
    var b = Math.max(range.x0, range.x1);
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      if (samples[i].d >= a - 1e-6 && samples[i].d <= b + 1e-6) out.push(samples[i]);
    }
    return out;
  }

  function linreg(pts) {
    var n = pts.length;
    if (n < 2) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      var x = pts[i].d;
      var y = pts[i].z;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-6) return null;
    var m = (n * sxy - sx * sy) / denom;
    var b = (sy - m * sx) / n;
    var ss = 0;
    for (var j = 0; j < n; j++) {
      var e = pts[j].z - (m * pts[j].d + b);
      ss += e * e;
    }
    return { m: m, b: b, n: n, rmse: Math.sqrt(ss / n) };
  }

  function fitRange(samples, range) {
    var pts = pointsInRange(samples, range);
    var fit = linreg(pts);
    if (!fit) return null;
    fit.x0 = Math.min(range.x0, range.x1);
    fit.x1 = Math.max(range.x0, range.x1);
    return fit;
  }

  function slopeDeg(m) { return toDeg(Math.atan(m)); }

  function measure(profile) {
    var samples = profile && profile.samples ? profile.samples : [];
    var fits = profile && profile.fits ? profile.fits : {};
    var upper = fitRange(samples, fits.upper);
    var lower = fitRange(samples, fits.lower);
    var face = fitRange(samples, fits.face);
    var result = {
      upper: upper,
      lower: lower,
      face: face,
      complete: false,
      lengthM: profile && profile.lengthM
    };
    if (!upper || !lower || !face) return result;
    var xm = (face.x0 + face.x1) / 2;
    var zU = upper.m * xm + upper.b;
    var zL = lower.m * xm + lower.b;
    var throwM = zU - zL;
    var dip = Number(profile.dip);
    if (!isFinite(dip)) dip = 60;
    var heave;
    var netSlip;
    if (dip >= 89.95) {
      heave = 0;
      netSlip = throwM;
    } else if (dip <= 0.05) {
      heave = null;
      netSlip = null;
    } else {
      var dipRad = toRad(dip);
      heave = throwM / Math.tan(dipRad);
      netSlip = throwM / Math.sin(dipRad);
    }
    var scarpHeight = null;
    var xTop = null;
    var xBase = null;
    var heightNote = '';
    if (Math.abs(face.m - upper.m) > 1e-9 && Math.abs(face.m - lower.m) > 1e-9) {
      xTop = (upper.b - face.b) / (face.m - upper.m);
      xBase = (lower.b - face.b) / (face.m - lower.m);
      if (isFinite(xTop) && isFinite(xBase)) {
        var zTop = face.m * xTop + face.b;
        var zBase = face.m * xBase + face.b;
        scarpHeight = zTop - zBase;
      }
    }
    var faceRelief = (face.m * face.x0 + face.b) - (face.m * face.x1 + face.b);
    var lengthM = samples.length ? samples[samples.length - 1].d : (profile.lengthM || 0);
    var inside = xTop != null && xBase != null
      && xTop > -0.25 * lengthM && xTop < 1.25 * lengthM
      && xBase > -0.25 * lengthM && xBase < 1.25 * lengthM;
    if (scarpHeight == null || !inside) {
      scarpHeight = faceRelief;
      xTop = face.x0;
      xBase = face.x1;
      heightNote = 'Scarp height is the fitted face relief. The surface lines do not both cross the face inside the profile.';
    }
    result.complete = true;
    result.throwM = throwM;
    result.heave = heave;
    result.netSlip = netSlip;
    result.scarpHeight = scarpHeight;
    result.heightNote = heightNote;
    result.faceSlope = slopeDeg(face.m);
    result.upperSlope = slopeDeg(upper.m);
    result.lowerSlope = slopeDeg(lower.m);
    result.farFieldSlope = slopeDeg((upper.m + lower.m) / 2);
    result.xm = xm;
    result.zU = zU;
    result.zL = zL;
    result.xTop = xTop;
    result.xBase = xBase;
    result.dip = dip;
    result.lengthM = lengthM;
    return result;
  }

  function signedValue(value, antithetic) {
    if (!isFinite(value)) return null;
    return antithetic ? -value : value;
  }

  function totals(profiles) {
    var throwSum = 0;
    var heaveSum = 0;
    var slipSum = 0;
    var n = 0;
    var haveSlip = true;
    for (var i = 0; i < profiles.length; i++) {
      var p = profiles[i];
      if (p.include === false) continue;
      var m = measure(p);
      if (!m.complete || !isFinite(m.throwM) || !isFinite(m.heave)) continue;
      throwSum += signedValue(m.throwM, p.antithetic);
      heaveSum += signedValue(m.heave, p.antithetic);
      if (isFinite(m.netSlip)) slipSum += signedValue(m.netSlip, p.antithetic);
      else haveSlip = false;
      n += 1;
    }
    return {
      n: n,
      throwM: n ? throwSum : null,
      heave: n ? heaveSum : null,
      netSlip: n && haveSlip ? slipSum : null
    };
  }

  function suggestGroupName(names) {
    var used = {};
    for (var i = 0; i < names.length; i++) used[names[i]] = true;
    if (!used['Range front']) return 'Range front';
    var k = 1;
    while (used['Piedmont scarp ' + k]) k += 1;
    return 'Piedmont scarp ' + k;
  }

  function ageColor(age) {
    var s = String(age || '').toLowerCase();
    if (s.indexOf('historic') >= 0) return '#9b2226';
    if (s.indexOf('holocene') >= 0 && s.indexOf('pleistocene') < 0) return '#e85d04';
    if (s.indexOf('pleistocene') >= 0 || s.indexOf('latest') >= 0) return '#ee9b00';
    if (s.indexOf('late') >= 0) return '#bb3e03';
    if (s.indexOf('middle') >= 0 || s.indexOf('mid') >= 0) return '#0a9396';
    if (s.indexOf('undifferentiated') >= 0) return '#ae2012';
    return '#9b2226';
  }

  function linePartsFromGeometry(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'LineString' && geometry.coordinates) return [geometry.coordinates];
    if (geometry.type === 'MultiLineString' && geometry.coordinates) return geometry.coordinates;
    if (geometry.paths) return geometry.paths;
    return [];
  }

  function swapEnds(profile) {
    var samples = profile.samples || [];
    var verts = verticesOf(profile);
    verts.reverse();
    profile.vertices = verts;
    profile.start = { lat: verts[0].lat, lng: verts[0].lng };
    profile.end = { lat: verts[verts.length - 1].lat, lng: verts[verts.length - 1].lng };
    profile.lengthM = pathLength(verts);
    var L = samples.length ? samples[samples.length - 1].d : profile.lengthM;
    var flipped = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      flipped.push({
        lat: s.lat,
        lng: s.lng,
        z: s.z,
        d: L - s.d,
        resolution: s.resolution
      });
    }
    flipped.sort(function (a, b) { return a.d - b.d; });
    profile.samples = flipped;
    var fits = profile.fits || {};
    var next = {};
    ['upper', 'lower', 'face'].forEach(function (key) {
      var f = fits[key];
      if (!f) return;
      next[key] = { x0: L - f.x1, x1: L - f.x0 };
    });
    profile.fits = next;
    return profile;
  }

  function profileToFeature(profile) {
    var m = measure(profile);
    return {
      type: 'Feature',
      id: profile.id,
      properties: {
        id: profile.id,
        group: profile.group,
        notes: profile.notes || '',
        antithetic: !!profile.antithetic,
        include: profile.include !== false,
        dip_deg: profile.dip,
        spacing_m: profile.spacing,
        length_m: profile.lengthM,
        elevation_source: profile.elevationSource || '',
        fault_name: profile.fault && profile.fault.fault_name || '',
        fault_age: profile.fault && profile.fault.age || '',
        fault_slip_rate: profile.fault && profile.fault.slip_rate || '',
        fault_dip_direction: profile.fault && profile.fault.dip_direction || '',
        method: profile.method || '',
        fits: profile.fits || {},
        samples: profile.samples || [],
        throw_m: m.complete ? round(m.throwM, 3) : null,
        heave_m: m.complete ? round(m.heave, 3) : null,
        net_slip_m: m.complete ? round(m.netSlip, 3) : null,
        scarp_height_m: m.complete ? round(m.scarpHeight, 3) : null
      },
      geometry: {
        type: 'LineString',
        coordinates: verticesOf(profile).map(function (v) { return [v.lng, v.lat]; })
      }
    };
  }

  function toGeoJSON(profiles) {
    return {
      type: 'FeatureCollection',
      name: 'scarp-profiles',
      features: profiles.map(profileToFeature)
    };
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function fromGeoJSON(fc) {
    var features = fc && fc.type === 'Feature' ? [fc] : (fc && fc.features) || [];
    var profiles = [];
    features.forEach(function (ft, index) {
      if (!ft || !ft.geometry || ft.geometry.type !== 'LineString') return;
      var coords = ft.geometry.coordinates || [];
      if (coords.length < 2) return;
      var props = ft.properties || {};
      var vertices = [];
      coords.forEach(function (c) {
        if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
        vertices.push({ lng: c[0], lat: c[1] });
      });
      if (vertices.length < 2) return;
      var start = vertices[0];
      var end = vertices[vertices.length - 1];
      var samples = [];
      (props.samples || []).forEach(function (s) {
        if (!s || !isFinite(Number(s.d)) || !isFinite(Number(s.z))) return;
        samples.push({
          d: Number(s.d),
          z: Number(s.z),
          lat: isFinite(Number(s.lat)) ? Number(s.lat) : null,
          lng: isFinite(Number(s.lng)) ? Number(s.lng) : null,
          resolution: isFinite(Number(s.resolution)) ? Number(s.resolution) : null
        });
      });
      samples.sort(function (a, b) { return a.d - b.d; });
      var fitsIn = props.fits || {};
      var fits = {};
      ['upper', 'lower', 'face'].forEach(function (key) {
        var f = fitsIn[key];
        if (f && isFinite(Number(f.x0)) && isFinite(Number(f.x1))) {
          fits[key] = { x0: Number(f.x0), x1: Number(f.x1) };
        }
      });
      var fault = null;
      if (props.fault_name) {
        fault = {
          fault_name: props.fault_name,
          age: props.fault_age || '',
          slip_rate: props.fault_slip_rate || '',
          dip_direction: props.fault_dip_direction || ''
        };
      }
      profiles.push({
        id: String(props.id || ft.id || ('import-' + index + '-' + Math.random().toString(36).slice(2, 8))),
        group: props.group || ('Imported ' + (index + 1)),
        notes: props.notes || '',
        antithetic: !!props.antithetic,
        include: props.include !== false,
        dip: num(props.dip_deg, 60),
        spacing: num(props.spacing_m, 2),
        lengthM: num(props.length_m, pathLength(vertices)),
        elevationSource: props.elevation_source || '',
        fault: fault,
        method: props.method || 'import',
        fits: fits,
        samples: samples,
        vertices: vertices,
        start: start,
        end: end,
        needsSample: samples.length < 2
      });
    });
    return profiles;
  }

  function csvEscape(value) {
    var s = value == null ? '' : String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function round(n, d) {
    if (!isFinite(n)) return '';
    var p = Math.pow(10, d);
    return Math.round(n * p) / p;
  }

  var CSV_COLUMNS = [
    'group', 'fault_name', 'length_m', 'throw_m', 'heave_m', 'net_slip_m', 'dip_deg',
    'antithetic', 'include_in_total', 'signed_throw_m', 'signed_heave_m',
    'scarp_height_m', 'face_slope_deg', 'upper_slope_deg', 'lower_slope_deg',
    'far_field_slope_deg', 'notes', 'elevation_source', 'spacing_m',
    'start_lat', 'start_lng', 'end_lat', 'end_lng'
  ];

  function csvRowFor(profile) {
    var m = measure(profile);
    var signedThrow = m.complete ? signedValue(m.throwM, profile.antithetic) : null;
    var signedHeave = m.complete ? signedValue(m.heave, profile.antithetic) : null;
    var faultName = profile.fault && profile.fault.fault_name || '';
    var values = {
      group: profile.group,
      fault_name: faultName,
      length_m: round(profile.lengthM, 2),
      throw_m: m.complete ? round(m.throwM, 2) : '',
      heave_m: m.complete ? round(m.heave, 2) : '',
      net_slip_m: m.complete ? round(m.netSlip, 2) : '',
      dip_deg: profile.dip,
      antithetic: profile.antithetic ? 'yes' : 'no',
      include_in_total: profile.include === false ? 'no' : 'yes',
      signed_throw_m: m.complete && profile.include !== false ? round(signedThrow, 2) : '',
      signed_heave_m: m.complete && profile.include !== false ? round(signedHeave, 2) : '',
      scarp_height_m: m.complete ? round(m.scarpHeight, 2) : '',
      face_slope_deg: m.complete ? round(m.faceSlope, 2) : '',
      upper_slope_deg: m.upper ? round(m.upperSlope, 2) : '',
      lower_slope_deg: m.lower ? round(m.lowerSlope, 2) : '',
      far_field_slope_deg: m.complete ? round(m.farFieldSlope, 2) : '',
      notes: profile.notes || '',
      elevation_source: profile.elevationSource || '',
      spacing_m: profile.spacing,
      start_lat: round(profile.start.lat, 6),
      start_lng: round(profile.start.lng, 6),
      end_lat: round(profile.end.lat, 6),
      end_lng: round(profile.end.lng, 6)
    };
    return CSV_COLUMNS.map(function (col) { return csvEscape(values[col]); }).join(',');
  }

  function toCSV(profiles) {
    var lines = [CSV_COLUMNS.join(',')];
    profiles.forEach(function (p) { lines.push(csvRowFor(p)); });
    var t = totals(profiles);
    if (t.n) {
      var total = {
        group: 'TOTAL linked scarps (' + t.n + ')',
        fault_name: '',
        length_m: '',
        throw_m: round(t.throwM, 2),
        heave_m: round(t.heave, 2),
        net_slip_m: t.netSlip == null ? '' : round(t.netSlip, 2),
        dip_deg: '',
        antithetic: '',
        include_in_total: 'yes',
        signed_throw_m: round(t.throwM, 2),
        signed_heave_m: round(t.heave, 2),
        scarp_height_m: '',
        face_slope_deg: '',
        upper_slope_deg: '',
        lower_slope_deg: '',
        far_field_slope_deg: '',
        notes: 'Antithetic rows subtracted. Excluded rows omitted.',
        elevation_source: '',
        spacing_m: '',
        start_lat: '',
        start_lng: '',
        end_lat: '',
        end_lng: ''
      };
      lines.push(CSV_COLUMNS.map(function (col) { return csvEscape(total[col]); }).join(','));
    }
    return lines.join('\n') + '\n';
  }

  function pointsAlong(vertices, spacingM) {
    if (!vertices || vertices.length < 2) return [];
    var total = pathLength(vertices);
    if (total < 1) return [];
    var spacing = Math.max(1, spacingM || 2);
    var n = Math.max(2, Math.round(total / spacing) + 1);
    if (n > 400) n = 400;
    var pts = [];
    for (var i = 0; i < n; i++) {
      var d = total * (i / (n - 1));
      var p = pointAtDistance(vertices, d);
      p.d = d;
      pts.push(p);
    }
    return pts;
  }

  return {
    haversine: haversine,
    bearing: bearing,
    destination: destination,
    midpoint: midpoint,
    projectPointToSegment: projectPointToSegment,
    nearestOnLine: nearestOnLine,
    dipBearing: dipBearing,
    chooseHangingBearing: chooseHangingBearing,
    sideBearing: sideBearing,
    perpendicularProfile: perpendicularProfile,
    pathLength: pathLength,
    verticesOf: verticesOf,
    pointAtDistance: pointAtDistance,
    projectSamples: projectSamples,
    downsample: downsample,
    resolutionNote: resolutionNote,
    linreg: linreg,
    measure: measure,
    signedValue: signedValue,
    totals: totals,
    suggestGroupName: suggestGroupName,
    ageColor: ageColor,
    linePartsFromGeometry: linePartsFromGeometry,
    swapEnds: swapEnds,
    toGeoJSON: toGeoJSON,
    fromGeoJSON: fromGeoJSON,
    toCSV: toCSV,
    pointsAlong: pointsAlong
  };
}));
