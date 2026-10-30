(function () {
  var map, layer, features = [], selected = new Set();
  var feedback = document.getElementById("feedback");
  var countEl = document.getElementById("count");

  function say(text, kind) {
    feedback.className = "feedback" + (kind ? " " + kind : "");
    feedback.textContent = text;
  }

  function style(feature) {
    var type = String(feature.properties.Type || "").toLowerCase();
    var index = type === "index";
    var on = selected.has(feature.properties.id);
    return {
      color: on ? "#0b57d0" : (index ? "#3a2412" : "#8d6b45"),
      weight: on ? (index ? 6 : 5) : (index ? 3.6 : 1.35),
      opacity: 0.95
    };
  }

  function restyle() {
    if (!layer) return;
    layer.eachLayer(function (lyr) {
      lyr.setStyle(style(lyr.feature));
      if (selected.has(lyr.feature.properties.id)) lyr.bringToFront();
    });
  }

  function renderTable() {
    var body = document.getElementById("rows");
    body.innerHTML = "";
    var rows = features.filter(function (f) { return selected.has(f.properties.id); });
    countEl.textContent = "Selected " + selected.size + " of " + features.length + ".";
    rows.slice(0, 40).forEach(function (f) {
      var tr = document.createElement("tr");
      tr.className = "selected";
      tr.innerHTML = "<td>" + f.properties.id + "</td><td>" + f.properties.Contour + "</td><td>" + (f.properties.Type || "") + "</td>";
      body.appendChild(tr);
    });
    if (rows.length > 40) {
      var more = document.createElement("tr");
      more.innerHTML = "<td colspan=\"3\">Showing 40 of " + rows.length + " selected rows.</td>";
      body.appendChild(more);
    }
    if (!rows.length) {
      var empty = document.createElement("tr");
      empty.innerHTML = "<td colspan=\"3\">No features selected.</td>";
      body.appendChild(empty);
    }
  }

  function runSelect() {
    var text = document.getElementById("sql").value;
    var test;
    try { test = LabSQL.compile(text); }
    catch (err) { say(err.message, "bad"); return; }
    selected = new Set();
    features.forEach(function (f) {
      if (test(f.properties)) selected.add(f.properties.id);
    });
    restyle();
    renderTable();
    say(selected.size ? "Selected " + selected.size + " contours." : "That clause selected nothing. AND means both sides must be true.", selected.size ? "ok" : "warn");
  }

  function calculate() {
    var value = document.getElementById("calc").value.trim().toLowerCase();
    if (value !== "index" && value !== "intermediate") {
      say("Calculate Field for Type accepts index or intermediate.", "bad");
      return;
    }
    if (!selected.size) {
      say("Nothing is selected, so no rows were changed. In Pro, an empty selection would update every row. Select first.", "warn");
      return;
    }
    features.forEach(function (f) {
      if (selected.has(f.properties.id)) f.properties.Type = value;
    });
    restyle();
    renderTable();
    say("Updated Type to " + value + " on " + selected.size + " selected contours. Index lines draw thicker.", "ok");
  }

  function check() {
    if (!features.length) return;
    var badIndex = features.filter(function (f) {
      return f.properties.Contour % 100 === 0 && String(f.properties.Type).toLowerCase() !== "index";
    });
    var badOther = features.filter(function (f) {
      return f.properties.Contour % 100 !== 0 && String(f.properties.Type).toLowerCase() !== "intermediate";
    });
    if (!badIndex.length && !badOther.length) {
      say("Passed. Every multiple of 100 m is index and the rest are intermediate.", "ok");
      LabStore.mark("contours");
      return;
    }
    say(badIndex.length + " index contours and " + badOther.length + " intermediate contours still have the wrong Type. Select each group and calculate the field.", "bad");
  }

  function reset() {
    features.forEach(function (f) { f.properties.Type = ""; });
    selected = new Set();
    document.getElementById("sql").value = "";
    document.getElementById("calc").value = "";
    restyle();
    renderTable();
    say("Type values cleared and the selection is empty.", "");
  }

  Promise.all([
    fetch("data/contours.geojson").then(function (r) { return r.json(); }),
    fetch("data/hillshade.json").then(function (r) { return r.json(); })
  ]).then(function (parts) {
    features = parts[0].features;
    var hill = parts[1];
    document.getElementById("credit").textContent = hill.credit + " Contour interval " + hill.interval + " m. Elevations on this clip run from about " + Math.round(hill.minElev) + " m to " + Math.round(hill.maxElev) + " m.";
    map = L.map("map", { zoomControl: true });
    window.labMap = map;
    L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", {
      attribution: "U.S. Geological Survey, The National Map",
      maxZoom: 18,
      maxNativeZoom: 16
    }).addTo(map);
    var shade = L.imageOverlay("data/hillshade.jpg", [[hill.south, hill.west], [hill.north, hill.east]], { opacity: 0.72 });
    shade.addTo(map);
    document.getElementById("shade").addEventListener("input", function () {
      shade.setOpacity(Number(this.value) / 100);
    });
    layer = L.geoJSON(parts[0], { style: style }).addTo(map);
    L.control.scale({ imperial: false, metric: true }).addTo(map);
    map.fitBounds([[hill.south, hill.west], [hill.north, hill.east]], { padding: [8, 8] });
    renderTable();
  }).catch(function () {
    say("Contour data did not load. Refresh the page.", "bad");
  });

  document.getElementById("sql").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") runSelect();
  });
  document.getElementById("select").addEventListener("click", runSelect);
  document.getElementById("clear").addEventListener("click", function () {
    selected = new Set();
    restyle();
    renderTable();
    say("Selection cleared.", "");
  });
  document.getElementById("example").addEventListener("click", function () {
    document.getElementById("sql").value = "Contour > 2200";
    document.getElementById("sql").focus();
  });
  document.getElementById("calc-btn").addEventListener("click", calculate);
  document.getElementById("check").addEventListener("click", check);
  document.getElementById("reset").addEventListener("click", reset);
})();
