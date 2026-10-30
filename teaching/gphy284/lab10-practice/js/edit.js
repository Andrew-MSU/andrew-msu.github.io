(function () {
  var map, scan, task, features, original, layer, sketchLayer, vertexLayer;
  var tool = "pan";
  var sketch = [];
  var feedback = document.getElementById("feedback");
  var statusEl = document.getElementById("status");

  function say(text, kind) {
    feedback.className = "feedback" + (kind ? " " + kind : "");
    feedback.textContent = text;
  }
  function status(text) { statusEl.textContent = text; }
  function maxId() {
    return features.reduce(function (m, f) { return Math.max(m, f.properties.id); }, 0);
  }
  function snapMeters() {
    var y = map.getSize().y || 400;
    var b = map.getBounds();
    var meters = map.distance(b.getNorthWest(), b.getSouthWest());
    return Math.max(40, Math.min(170, (meters / y) * 24));
  }
  function norm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }

  function style(feature) {
    var p = feature.properties;
    var added = p.kind === "added";
    return {
      color: p.splitThis ? "#111" : (added ? "#083e75" : "#222"),
      weight: p.splitThis ? 4 : (added ? 3 : 1.5),
      fillColor: added && !p.formation ? "#ffffff" : (p.color || "#ccc"),
      fillOpacity: p.splitThis ? 0.55 : 0.48
    };
  }

  function draw() {
    if (layer) map.removeLayer(layer);
    layer = L.geoJSON({ type: "FeatureCollection", features: features }, {
      style: style,
      onEachFeature: function (feature, lyr) {
        var p = feature.properties;
        var label = p.unit + " · " + p.formation;
        lyr.bindTooltip(p.splitThis ? "Split this polygon · " + label : label, {
          permanent: !!p.splitThis,
          direction: "center",
          className: p.splitThis ? "split-tip" : ""
        });
        lyr.on("click", function () {
          if (tool !== "pan") return;
          document.querySelectorAll("#rows tr").forEach(function (tr) {
            tr.classList.toggle("selected", Number(tr.dataset.id) === p.id);
          });
        });
      }
    }).addTo(map);
    drawSketch();
    drawTable();
  }

  function drawSketch() {
    if (sketchLayer) map.removeLayer(sketchLayer);
    if (vertexLayer) map.removeLayer(vertexLayer);
    if (!sketch.length) return;
    sketchLayer = L.polyline(sketch.map(function (p) { return [p[1], p[0]]; }), { color: "#083e75", weight: 4 }).addTo(map);
    vertexLayer = L.layerGroup(sketch.map(function (p) {
      return L.circleMarker([p[1], p[0]], { radius: 7, color: "#fff", weight: 2, fillColor: "#083e75", fillOpacity: 1 });
    })).addTo(map);
  }

  function drawTable() {
    var body = document.getElementById("rows");
    body.innerHTML = "";
    features.forEach(function (f) {
      var p = f.properties;
      var tr = document.createElement("tr");
      tr.dataset.id = String(p.id);
      var formationCell = document.createElement("td");
      if (p.kind === "added") {
        var input = document.createElement("input");
        input.value = p.formation || "";
        input.setAttribute("aria-label", "Formation for new polygon " + p.id);
        input.setAttribute("list", "formations");
        input.addEventListener("input", function () { p.formation = input.value; });
        formationCell.appendChild(input);
      } else {
        formationCell.textContent = p.formation;
      }
      tr.innerHTML = "<td>" + p.id + "</td><td>" + p.unit + "</td>";
      tr.appendChild(formationCell);
      var note = document.createElement("td");
      note.textContent = p.splitThis ? "Split this" : (p.kind === "added" ? "New" : (p.kind === "split" ? "From split" : ""));
      tr.appendChild(note);
      body.appendChild(tr);
    });
    var names = [];
    features.forEach(function (f) {
      if (f.properties.formation && names.indexOf(f.properties.formation) < 0 && f.properties.kind !== "added") {
        names.push(f.properties.formation);
      }
    });
    var list = document.getElementById("formations");
    list.innerHTML = names.map(function (n) { return "<option value=\"" + n.replace(/"/g, "&quot;") + "\"></option>"; }).join("");
  }

  function setTool(next) {
    tool = next;
    sketch = [];
    ["pan", "split", "complete"].forEach(function (name) {
      document.getElementById("tool-" + name).setAttribute("aria-pressed", name === tool ? "true" : "false");
    });
    if (tool === "split") status("Split: tap outside the outlined polygon, then across it, then Finish.");
    else if (tool === "complete") status("Auto-complete: start and end on the same outline, bow into an empty patch, then Finish.");
    else status("Pan the map with one finger. Pinch, or use + and −, to zoom.");
    drawSketch();
  }

  function finish() {
    if (!features) return;
    if (sketch.length < 2) { say("Add at least two vertices.", "warn"); return; }
    if (tool === "split") finishSplit();
    else if (tool === "complete") finishComplete();
    else say("Choose Split or Auto-complete first.", "warn");
  }

  function finishSplit() {
    var target = features.find(function (f) { return f.properties.splitThis; });
    if (!target) { say("The outlined polygon is already split. Continue with Auto-complete, or Reset to start over.", "warn"); return; }
    var hits = turf.lineIntersect(turf.lineString(sketch), turf.polygonToLine(target));
    if (hits.features.length < 2) {
      say("The line has to cross the outlined polygon in two places. Start and end outside it.", "bad");
      return;
    }
    var result = LabEdit.splitPolygon(target, sketch);
    if (result.error) { say(result.error, "bad"); return; }
    var pieces = result.rings.map(function (ring) { return turf.polygon([ring]); });
    if (pieces.some(function (poly) { return turf.kinks(poly).features.length; })) {
      say("That cut makes a tangled outline. Try a straighter line across the polygon.", "bad");
      return;
    }
    var areas = pieces.map(function (poly) { return turf.area(poly); });
    var orig = turf.area(target);
    if (Math.abs(areas[0] + areas[1] - orig) / orig > 0.05 || areas[0] < orig * 0.04 || areas[1] < orig * 0.04) {
      say("One piece is only a sliver, or the pieces do not add up. Cross more of the polygon.", "bad");
      return;
    }
    var id = maxId();
    var made = result.rings.map(function (ring, i) {
      return {
        type: "Feature",
        properties: {
          id: id + i + 1,
          unit: target.properties.unit,
          formation: target.properties.formation,
          color: target.properties.color,
          splitThis: false,
          kind: "split",
          parentId: target.properties.id
        },
        geometry: { type: "Polygon", coordinates: [ring] }
      };
    });
    features = features.filter(function (f) { return f !== target; }).concat(made);
    sketch = [];
    say("Split into two polygons. Attributes were copied to both, which is what Split does in Pro.", "ok");
    draw();
  }

  function finishComplete() {
    var result = LabEdit.autoComplete(features, sketch, snapMeters());
    if (result.error) { say(result.error, "bad"); return; }
    var chosen = null;
    (result.options || [{ ring: result.ring }]).forEach(function (opt) {
      var poly;
      try { poly = turf.polygon([opt.ring]); }
      catch (e) { return; }
      if (turf.kinks(poly).features.length) return;
      var area = turf.area(poly);
      if (area < 8000) return;
      var overlap = 0;
      features.forEach(function (f) {
        try {
          var inter = turf.intersect(poly, f);
          if (inter) overlap += turf.area(inter);
        } catch (e) { /* boundary sliver */ }
      });
      var frac = overlap / area;
      if (frac > 0.35) return;
      if (!chosen || frac < chosen.frac) chosen = { ring: opt.ring, frac: frac, area: area };
    });
    if (!chosen) {
      say("That shape covers geology that is already mapped. Bow the line into an empty patch.", "bad");
      return;
    }
    features.push({
      type: "Feature",
      properties: {
        id: maxId() + 1,
        unit: "",
        formation: "",
        color: "#f4f7fb",
        splitThis: false,
        kind: "added",
        attachedId: result.attachedId,
        attachedFormation: result.attachedFormation,
        attachedUnit: result.attachedUnit
      },
      geometry: { type: "Polygon", coordinates: [chosen.ring] }
    });
    sketch = [];
    say("New polygon shares an edge with " + result.attachedFormation + ". Type that formation name in the table.", "ok");
    draw();
    var row = document.querySelector("#rows tr:last-child input");
    if (row) row.focus();
  }

  function check() {
    if (!features || !task) return;
    var children = features.filter(function (f) { return f.properties.parentId === task.splitId; });
    var splitOk = children.length >= 2 && !features.some(function (f) { return f.properties.splitThis; });
    var added = features.filter(function (f) { return f.properties.kind === "added"; });
    var named = added.filter(function (f) {
      var typed = norm(f.properties.formation);
      return typed && (typed === norm(f.properties.attachedFormation) || typed === norm(f.properties.attachedUnit));
    });
    if (!splitOk) {
      say("The outlined " + task.splitName + " polygon still needs a Split that cuts it into two real pieces.", "bad");
      return;
    }
    if (!added.length) {
      say("Split is done. Use Auto-complete to add a polygon that shares an existing edge.", "bad");
      return;
    }
    if (!named.length) {
      say("The new polygon needs a Formation that matches the unit it snapped to. Read that name in the table.", "bad");
      return;
    }
    say("Passed. Split, Autocomplete Polygon, and an attribute edit — the same three ideas as the Pro edit tools.", "ok");
    LabStore.mark("edit");
  }

  function reset() {
    if (!original) return;
    features = JSON.parse(original);
    sketch = [];
    setTool("pan");
    say("Polygons restored.", "");
    draw();
  }

  Promise.all([
    fetch("data/geology.geojson").then(function (r) { return r.json(); }),
    fetch("data/geology.json").then(function (r) { return r.json(); }),
    fetch("data/scan.json").then(function (r) { return r.json(); })
  ]).then(function (parts) {
    var collection = parts[0];
    task = parts[1];
    scan = parts[2];
    features = collection.features;
    original = JSON.stringify(features);
    document.getElementById("split-name").textContent = task.splitName;
    document.getElementById("credit").textContent = task.credit + " Basemap scan: " + scan.credit;

    map = L.map("map", { zoomControl: true, doubleClickZoom: false });
    window.labMap = map;
    L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
      attribution: "U.S. Geological Survey, The National Map",
      maxZoom: 18,
      maxNativeZoom: 16
    }).addTo(map);
    L.imageOverlay("data/scan.jpg", [[scan.south, scan.west], [scan.north, scan.east]], { opacity: 0.88 }).addTo(map);
    L.control.scale({ imperial: false, metric: true }).addTo(map);
    map.fitBounds([[scan.south, scan.west], [scan.north, scan.east]], { padding: [8, 8] });
    map.on("click", function (e) {
      if (tool === "pan") return;
      sketch.push([e.latlng.lng, e.latlng.lat]);
      status((tool === "split" ? "Split" : "Auto-complete") + ": " + sketch.length + " vertices. Finish when the line is done. Undo removes the last one.");
      drawSketch();
    });
    draw();
    var legend = document.getElementById("legend");
    var seen = {};
    features.forEach(function (f) {
      if (seen[f.properties.unit]) return;
      seen[f.properties.unit] = true;
      var item = document.createElement("span");
      item.className = "swatch";
      item.innerHTML = "<i style=\"background:" + f.properties.color + "\"></i>" + f.properties.unit + " " + f.properties.formation;
      legend.appendChild(item);
    });
  }).catch(function () {
    say("Geology data did not load. Refresh the page.", "bad");
  });

  document.getElementById("tool-pan").addEventListener("click", function () { setTool("pan"); });
  document.getElementById("tool-split").addEventListener("click", function () { setTool("split"); });
  document.getElementById("tool-complete").addEventListener("click", function () { setTool("complete"); });
  document.getElementById("undo").addEventListener("click", function () {
    sketch.pop();
    drawSketch();
    status(sketch.length ? sketch.length + " vertices." : "Sketch cleared.");
  });
  document.getElementById("finish").addEventListener("click", finish);
  document.getElementById("check").addEventListener("click", check);
  document.getElementById("reset").addEventListener("click", reset);
  status("Pan the map, then choose Split.");
})();
