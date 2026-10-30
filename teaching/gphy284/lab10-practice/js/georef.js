(function () {
  var scan, img, viewer, map, overlay, points = [], pending = null, nextId = 1;
  var order = 1;
  var srcData = null;
  var warpKey = "";
  var feedback = document.getElementById("feedback");
  var statusEl = document.getElementById("status");
  var rmsEl = document.getElementById("rms");
  var listEl = document.getElementById("points");

  function say(text, kind) {
    feedback.className = "feedback" + (kind ? " " + kind : "");
    feedback.textContent = text;
  }
  function status(text) { statusEl.textContent = text; }

  function truthOf(x, y) {
    var px = x / img.naturalWidth;
    var py = y / img.naturalHeight;
    return {
      lon: scan.west + px * (scan.east - scan.west),
      lat: scan.north - py * (scan.north - scan.south)
    };
  }

  function activePoints() {
    return points.map(function (p) {
      return { x: p.x, y: p.y, lon: p.lng, lat: p.lat };
    });
  }

  function modelFor(which) {
    var need = LabTransform.minPoints(which);
    if (points.length < need) return null;
    return LabTransform.fit(activePoints(), which);
  }

  function paintMarkers() {
    var marks = points.map(function (p) {
      return { id: p.id, x: p.x, y: p.y, label: String(p.id) };
    });
    if (pending) marks.push({ id: "pending", x: pending.x, y: pending.y, label: "?", pending: true });
    viewer.setMarkers(marks);
    points.forEach(function (p) {
      if (!p.marker) return;
      p.marker.setLatLng([p.lat, p.lng]);
    });
  }

  function mapMarker(p) {
    var icon = L.divIcon({
      className: "",
      html: "<span class=\"pin\" style=\"position:relative;margin:0;display:grid;place-items:center\">" + p.id + "</span>",
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });
    var marker = L.marker([p.lat, p.lng], { icon: icon, draggable: true, autoPan: true });
    marker.on("dragend", function () {
      var ll = marker.getLatLng();
      p.lat = ll.lat;
      p.lng = ll.lng;
      refresh();
    });
    marker.addTo(map);
    p.marker = marker;
  }

  function renderList(fit1) {
    listEl.innerHTML = "";
    var res = fit1 ? LabTransform.residuals(fit1, activePoints()) : null;
    points.forEach(function (p, i) {
      var truth = truthOf(p.x, p.y);
      p.error = LabTransform.meters(truth.lon, truth.lat, p.lng, p.lat);
      p.fit = res ? res.each[i] : null;
      var li = document.createElement("li");
      li.className = "point";
      var fitText = p.fit == null ? "not fit yet" : "fit residual " + Math.round(p.fit) + " m";
      li.innerHTML = "<span><strong>" + p.id + "</strong> · " + fitText + " · map error " + Math.round(p.error) + " m</span>";
      var del = document.createElement("button");
      del.type = "button";
      del.className = "danger";
      del.textContent = "Delete";
      del.setAttribute("aria-label", "Delete control point " + p.id);
      del.addEventListener("click", function () {
        if (p.marker) map.removeLayer(p.marker);
        points = points.filter(function (q) { return q.id !== p.id; });
        refresh();
      });
      li.appendChild(del);
      listEl.appendChild(li);
    });
  }

  function cacheSource() {
    if (srcData) return srcData;
    var c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    srcData = ctx.getImageData(0, 0, c.width, c.height);
    return srcData;
  }

  function sample(data, w, h, x, y) {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var x1 = Math.min(x0 + 1, w - 1);
    var y1 = Math.min(y0 + 1, h - 1);
    var tx = x - x0;
    var ty = y - y0;
    function px(ix, iy) {
      var o = (iy * w + ix) * 4;
      return [data[o], data[o + 1], data[o + 2], data[o + 3]];
    }
    var a = px(x0, y0);
    var b = px(x1, y0);
    var c = px(x0, y1);
    var d = px(x1, y1);
    var out = [0, 0, 0, 0];
    for (var i = 0; i < 4; i++) {
      out[i] = a[i] * (1 - tx) * (1 - ty) + b[i] * tx * (1 - ty) + c[i] * (1 - tx) * ty + d[i] * tx * ty;
    }
    return out;
  }

  function drawOverlay(model) {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    if (!model) return;
    var w = img.naturalWidth;
    var h = img.naturalHeight;
    var minL = Infinity, minB = Infinity, maxL = -Infinity, maxB = -Infinity;
    for (var i = 0; i <= 6; i++) {
      [ [w * i / 6, 0], [w * i / 6, h], [0, h * i / 6], [w, h * i / 6] ].forEach(function (pt) {
        var g = LabTransform.apply(model, pt[0], pt[1]);
        minL = Math.min(minL, g[0]);
        maxL = Math.max(maxL, g[0]);
        minB = Math.min(minB, g[1]);
        maxB = Math.max(maxB, g[1]);
      });
    }
    var pad = 0.04;
    minL = Math.max(minL, scan.west - pad);
    maxL = Math.min(maxL, scan.east + pad);
    minB = Math.max(minB, scan.south - pad);
    maxB = Math.min(maxB, scan.north + pad);
    if (!(maxL > minL && maxB > minB)) return;
    var outW = 680;
    var outH = Math.max(2, Math.round(outW * (maxB - minB) / (maxL - minL) * (111000 / (111320 * Math.cos(((minB + maxB) / 2) * Math.PI / 180)))));
    if (outH > 720) { outH = 720; outW = Math.round(outH * (maxL - minL) / (maxB - minB) * ((111320 * Math.cos(((minB + maxB) / 2) * Math.PI / 180)) / 111000)); }
    var canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext("2d");
    var image = ctx.createImageData(outW, outH);
    var src = cacheSource();
    var buf = image.data;
    for (var y = 0; y < outH; y++) {
      var lat = maxB - (y + 0.5) / outH * (maxB - minB);
      for (var x = 0; x < outW; x++) {
        var lon = minL + (x + 0.5) / outW * (maxL - minL);
        var pix = LabTransform.invert(model, lon, lat);
        var o = (y * outW + x) * 4;
        if (!pix) { buf[o + 3] = 0; continue; }
        var s = sample(src.data, src.width, src.height, pix[0], pix[1]);
        if (!s) { buf[o + 3] = 0; continue; }
        buf[o] = s[0]; buf[o + 1] = s[1]; buf[o + 2] = s[2]; buf[o + 3] = s[3];
      }
    }
    ctx.putImageData(image, 0, 0);
    overlay = L.imageOverlay(canvas.toDataURL("image/png"), [[minB, minL], [maxB, maxL]], {
      opacity: Number(document.getElementById("opacity").value) / 100,
      interactive: false
    });
    overlay.addTo(map);
  }

  function refresh() {
    paintMarkers();
    var fit1 = modelFor(1);
    var shown = order === 2 ? modelFor(2) : fit1;
    if (order === 2 && !shown) shown = fit1;
    renderList(fit1);
    var text = "";
    if (points.length < 3) {
      text = "Add at least 3 points for a 1st-order (affine) fit. This exercise asks for 4 or more.";
    } else if (!fit1) {
      text = "Those points do not define a stable 1st-order fit. Spread them across the scan.";
    } else {
      var res = LabTransform.residuals(fit1, activePoints());
      text = "1st-order RMS " + Math.round(res.rms) + " m from " + points.length + " points.";
      if (order === 2 && points.length >= 6) {
        var fit2 = modelFor(2);
        if (fit2) {
          var res2 = LabTransform.residuals(fit2, activePoints());
          var gap = LabTransform.maxGap(fit1, fit2, img.naturalWidth, img.naturalHeight);
          text += " 2nd-order RMS " + Math.round(res2.rms) + " m. Between your points the two fits disagree by up to " + Math.round(gap) + " m.";
          if (res2.rms + 5 < res.rms && gap > 80) {
            text += " The lower RMS is partly the surface bending to honor the links. That is overfitting. A scanned paper map is almost affine, so the 1st-order fit is the one to trust.";
          }
        }
      } else if (order === 2) {
        text += " 2nd order needs 6 points. Showing the 1st-order fit.";
      }
    }
    rmsEl.textContent = text;
    var key = order + ":" + points.map(function (p) {
      return [p.x.toFixed(2), p.y.toFixed(2), p.lat.toFixed(6), p.lng.toFixed(6)].join(",");
    }).join("|");
    if (key !== warpKey) {
      warpKey = key;
      drawOverlay(shown);
    } else if (overlay) {
      overlay.setOpacity(Number(document.getElementById("opacity").value) / 100);
    }
    if (pending) status("Now tap the same place on the reference map, or type coordinates.");
    else status("Tap a place on the scan, then tap that place on the reference map.");
  }

  function addPoint(lat, lng) {
    var p = { id: nextId++, x: pending.x, y: pending.y, lat: lat, lng: lng };
    pending = null;
    points.push(p);
    mapMarker(p);
    refresh();
  }

  img = document.getElementById("scan");
  Promise.all([
    fetch("data/scan.json").then(function (r) { return r.json(); }),
    new Promise(function (resolve) {
      if (img.complete && img.naturalWidth) resolve();
      else img.onload = function () { resolve(); };
    })
  ]).then(function (parts) {
    scan = parts[0];
    document.getElementById("credit").textContent = scan.credit;
    var el = document.getElementById("viewer");
    viewer = createScanViewer(el, img);
    window.labViewer = viewer;
    viewer.onTap(function (x, y) {
      pending = { x: x, y: y };
      refresh();
    });
    viewer.onMarkerDrag(function (id, x, y, phase) {
      if (id === "pending") { pending = { x: x, y: y }; return; }
      var p = points.find(function (q) { return q.id === id; });
      if (!p) return;
      p.x = x;
      p.y = y;
      if (phase === "end") refresh();
    });
    document.getElementById("zin").addEventListener("click", function () { viewer.zoomBy(1.3); });
    document.getElementById("zout").addEventListener("click", function () { viewer.zoomBy(1 / 1.3); });
    document.getElementById("zfit").addEventListener("click", function () { viewer.fit(); });

    map = L.map("map", { zoomControl: true, doubleClickZoom: false, attributionControl: true });
    window.labMap = map;
    var topo = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
      attribution: "U.S. Geological Survey, The National Map",
      maxZoom: 18,
      maxNativeZoom: 16
    });
    var imagery = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", {
      attribution: "U.S. Geological Survey, The National Map",
      maxZoom: 18,
      maxNativeZoom: 16
    });
    topo.addTo(map);
    L.control.layers({ "USGS topo": topo, "USGS imagery": imagery }, null, {
      collapsed: window.matchMedia("(max-width: 700px)").matches
    }).addTo(map);
    L.control.scale({ imperial: false, metric: true }).addTo(map);
    var bounds = [[scan.south, scan.west], [scan.north, scan.east]];
    map.fitBounds(bounds, { padding: [12, 12] });
    map.setMaxBounds(L.latLngBounds(bounds).pad(0.8));
    map.on("click", function (e) {
      if (!pending) { status("Tap the scan first, then the matching place on this map."); return; }
      addPoint(e.latlng.lat, e.latlng.lng);
    });
    document.getElementById("use-coords").addEventListener("click", function () {
      if (!pending) { say("Tap the scan before typing coordinates.", "warn"); return; }
      var lon = Number(document.getElementById("lon").value);
      var lat = Number(document.getElementById("lat").value);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) { say("Enter longitude and latitude as decimal degrees.", "bad"); return; }
      addPoint(lat, lon);
    });
    document.getElementById("opacity").addEventListener("input", function () {
      if (overlay) overlay.setOpacity(Number(this.value) / 100);
    });
    document.getElementById("order1").addEventListener("click", function () {
      order = 1;
      document.getElementById("order1").setAttribute("aria-pressed", "true");
      document.getElementById("order2").setAttribute("aria-pressed", "false");
      refresh();
    });
    document.getElementById("order2").addEventListener("click", function () {
      order = 2;
      document.getElementById("order1").setAttribute("aria-pressed", "false");
      document.getElementById("order2").setAttribute("aria-pressed", "true");
      refresh();
    });
    document.getElementById("check").addEventListener("click", check);
    document.getElementById("reset").addEventListener("click", reset);
    refresh();
  }).catch(function () {
    say("The scan metadata did not load. Refresh the page.", "bad");
  });

  function check() {
    if (points.length < 4) {
      say("Place at least 4 control points. Three define an affine fit; the extra point shows residual error.", "bad");
      return;
    }
    var fit1 = modelFor(1);
    if (!fit1) { say("The 1st-order fit is unstable. Spread the points around the scan.", "bad"); return; }
    var res = LabTransform.residuals(fit1, activePoints());
    var errs = points.map(function (p) { return p.error; });
    var mean = errs.reduce(function (s, n) { return s + n; }, 0) / errs.length;
    var worst = Math.max.apply(null, errs);
    var worstPoint = points.slice().sort(function (a, b) { return b.error - a.error; })[0];
    if (mean <= 200 && worst <= 450 && res.rms <= 250) {
      say("Passed. Mean map error " + Math.round(mean) + " m, 1st-order RMS " + Math.round(res.rms) + " m. In Pro this is Add Control Points with a 1st Order Polynomial.", "ok");
      LabStore.mark("georef");
    } else {
      say("Not yet. Mean map error " + Math.round(mean) + " m (aim for under 200) and 1st-order RMS " + Math.round(res.rms) + " m. Point " + worstPoint.id + " is the farthest. Zoom in, drag it, or delete it.", "bad");
    }
  }

  function reset() {
    points.forEach(function (p) { if (p.marker) map.removeLayer(p.marker); });
    points = [];
    pending = null;
    nextId = 1;
    order = 1;
    document.getElementById("order1").setAttribute("aria-pressed", "true");
    document.getElementById("order2").setAttribute("aria-pressed", "false");
    say("Cleared. The scan is unreferenced again.", "");
    refresh();
  }
})();
