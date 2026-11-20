/* Scarp profiler. Map, USGS services, and the measurement panel.
   Geometry and the throw / heave math live in logic.js. */
(function () {
  var L = window.L;
  var Chart = window.Chart;
  var S = window.ScarpLogic;
  var $ = function (id) { return document.getElementById(id); };

  var STORE = 'scarpProfiler.v1';
  var QFAULT = 'https://earthquake.usgs.gov/arcgis/rest/services/haz/Qfaults/MapServer';
  var SAMPLES = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
  var EPQS = 'https://epqs.nationalmap.gov/v1/json';
  var CLASS_GLOSS = {
    A: 'Class A — a Quaternary tectonic fault, well supported by the geology',
    B: 'Class B — Quaternary deformation, but the evidence is equivocal',
    C: 'Class C — not enough evidence for a Quaternary tectonic fault',
    D: 'Class D — the evidence says this is not a tectonic fault'
  };

  if (!L || !L.map || !Chart || !S) {
    $('status').textContent = 'The map library failed to load. Reload the page.';
    return;
  }

  var state = {
    profiles: [],
    activeId: null,
    mode: 'fault',
    draft: null,
    basemap: 'hill',
    spacing: 2,
    lengthM: 600,
    nextName: 'Range front',
    hwSide: 'left',
    qfault: true,
    ve: 4,
    pick: null,
    pickX0: null,
    faultToken: 0,
    faultBounds: null,
    identifyToken: 0,
    sampleToken: 0,
    view: null
  };

  var map, chart, faultLayer, faultRaster, profileLayer, draftLayer, highlightLayer;
  var basemaps = {};
  var suspend = false;
  var saveTimer = null;
  var hillWarned = false;

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!raw || raw.version !== 1) return;
      state.profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      state.profiles.forEach(function (p) {
        p.fits = p.fits || {};
        p.samples = p.samples || [];
        if (p.include == null) p.include = true;
        if (!p.vertices || p.vertices.length < 2) p.vertices = S.verticesOf(p);
      });
      state.activeId = raw.activeId || (state.profiles[0] && state.profiles[0].id) || null;
      state.mode = raw.mode || 'fault';
      state.basemap = raw.basemap || 'hill';
      state.spacing = Number(raw.spacing) || 2;
      state.lengthM = Number(raw.lengthM) || 600;
      state.nextName = raw.nextName || S.suggestGroupName(state.profiles.map(function (p) { return p.group; }));
      state.hwSide = raw.hwSide || 'left';
      state.qfault = raw.qfault !== false;
      state.ve = Number(raw.ve) || 4;
      state.view = raw.view || null;
    } catch (err) { /* empty session */ }
  }

  function payload() {
    return {
      version: 1,
      profiles: state.profiles,
      activeId: state.activeId,
      mode: state.mode,
      basemap: state.basemap,
      spacing: state.spacing,
      lengthM: state.lengthM,
      nextName: $('group-name').value,
      hwSide: state.hwSide,
      qfault: state.qfault,
      ve: Number($('ve').value) || 4,
      view: viewObject()
    };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORE, JSON.stringify(payload())); }
      catch (err) {
        setStatus('This browser could not store the session. Export GeoJSON so the measurements are not lost.');
      }
    }, 150);
  }

  function viewObject() {
    if (!map) return state.view;
    var c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  }

  function setStatus(text) { $('status').textContent = text; }

  function showProgress(label, pct) {
    $('progress').hidden = false;
    $('progress-label').textContent = label;
    var bar = $('progress-bar');
    if (pct == null) {
      bar.classList.add('indeterminate');
      bar.style.width = '40%';
    } else {
      bar.classList.remove('indeterminate');
      bar.style.width = Math.round(pct * 100) + '%';
    }
  }

  function hideProgress() { $('progress').hidden = true; }

  function active() {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === state.activeId) return state.profiles[i];
    }
    return null;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmt(n, d) {
    if (!isFinite(n)) return '—';
    return n.toFixed(d == null ? 1 : d);
  }

  function slopeText(deg) {
    if (!isFinite(deg)) return '—';
    var dir = deg < -0.05 ? 'down-profile' : (deg > 0.05 ? 'up-profile' : 'flat');
    return Math.abs(deg).toFixed(1) + '° ' + dir;
  }

  /* --- map --- */

  var DepHillshade = L.TileLayer.extend({
    initialize: function (options) {
      L.TileLayer.prototype.initialize.call(this, '', L.extend({
        tileSize: 256,
        maxZoom: 19,
        maxNativeZoom: 18,
        attribution: 'USGS 3DEP',
        rasterFunction: 'Hillshade Gray'
      }, options));
    },
    getTileUrl: function (coords) {
      var half = Math.PI * 6378137;
      var span = (2 * half) / Math.pow(2, coords.z);
      var xmin = -half + coords.x * span;
      var xmax = xmin + span;
      var ymax = half - coords.y * span;
      var ymin = ymax - span;
      var bbox = [xmin, ymin, xmax, ymax].map(function (v) { return v.toFixed(2); }).join(',');
      var rule = encodeURIComponent(JSON.stringify({ rasterFunction: this.options.rasterFunction }));
      return 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
        + '?bbox=' + bbox + '&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng'
        + '&renderingRule=' + rule + '&f=image';
    }
  });

  var FaultRaster = L.TileLayer.extend({
    initialize: function (options) {
      L.TileLayer.prototype.initialize.call(this, '', L.extend({
        tileSize: 256,
        maxZoom: 19,
        maxNativeZoom: 16,
        opacity: 0.95,
        attribution: 'USGS Quaternary Fault and Fold Database'
      }, options));
    },
    getTileUrl: function (coords) {
      var half = Math.PI * 6378137;
      var span = (2 * half) / Math.pow(2, coords.z);
      var xmin = -half + coords.x * span;
      var xmax = xmin + span;
      var ymax = half - coords.y * span;
      var ymin = ymax - span;
      var bbox = [xmin, ymin, xmax, ymax].map(function (v) { return v.toFixed(2); }).join(',');
      return QFAULT + '/export?bbox=' + bbox
        + '&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:21&f=image';
    }
  });

  function initMap() {
    var view = state.view && isFinite(state.view.lat) ? state.view : { lat: 40.77, lng: -111.82, zoom: 14 };
    map = L.map('map', { zoomControl: false, attributionControl: true }).setView([view.lat, view.lng], view.zoom || 14);
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.createPane('profiles');
    map.getPane('profiles').style.zIndex = 450;
    basemaps.hill = new DepHillshade({ rasterFunction: 'Hillshade Gray' });
    basemaps.multi = new DepHillshade({ rasterFunction: 'Hillshade Multidirectional' });
    basemaps.shade = L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 16, attribution: 'USGS The National Map' }
    );
    basemaps.imagery = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' }
    );
    basemaps.topo = L.tileLayer(
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 16, attribution: 'USGS The National Map' }
    );
    Object.keys(basemaps).forEach(function (key) {
      basemaps[key].on('tileerror', function () {
        if (hillWarned || state.basemap !== key) return;
        if (key !== 'hill' && key !== 'multi') return;
        hillWarned = true;
        setStatus('A 3DEP hillshade tile failed. Switch the basemap to USGS shaded relief if the map stays blank.');
      });
    });
    (basemaps[state.basemap] || basemaps.hill).addTo(map);
    faultRaster = new FaultRaster();
    faultLayer = L.featureGroup().addTo(map);
    profileLayer = L.featureGroup().addTo(map);
    draftLayer = L.layerGroup().addTo(map);
    highlightLayer = L.layerGroup().addTo(map);
    L.control.scale({ imperial: false, metric: true, position: 'bottomleft' }).addTo(map);
    map.on('click', onMapClick);
    map.on('mousemove', onMouseMove);
    map.on('moveend', function () {
      clearTimeout(map._faultTimer);
      map._faultTimer = setTimeout(loadFaults, 350);
      persist();
    });
    document.addEventListener('keydown', function (ev) {
      var tag = document.activeElement && document.activeElement.tagName;
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (ev.key === 'Escape') {
        if (typing) return;
        cancelDraft();
        return;
      }
      if (typing || state.mode !== 'profile' || !state.draft) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        finishProfileDraft(false);
      } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        undoVertex();
      }
    });
    map.on('dblclick', function (e) {
      if (state.mode !== 'profile' || !state.draft) return;
      L.DomEvent.stop(e);
      finishProfileDraft(true);
    });
  }

  function setBasemap(name) {
    if (!basemaps[name]) name = 'hill';
    Object.keys(basemaps).forEach(function (key) {
      if (map.hasLayer(basemaps[key])) map.removeLayer(basemaps[key]);
    });
    basemaps[name].addTo(map);
    basemaps[name].bringToBack();
    state.basemap = name;
    $('basemap').value = name;
    persist();
  }

  /* --- Quaternary faults --- */

  function normalizeFault(raw) {
    raw = raw || {};
    function pick() {
      for (var i = 0; i < arguments.length; i++) {
        if (raw[arguments[i]]) return raw[arguments[i]];
      }
      return '';
    }
    return {
      fault_name: pick('fault_name', 'Fault Name') || 'Unnamed fault',
      section_name: pick('section_name', 'Section Name'),
      age: pick('age', 'Age'),
      slip_rate: pick('slip_rate', 'Slip Rate(mm/year)'),
      dip_direction: pick('dip_direction', 'Dip Direction'),
      slip_sense: pick('slip_sense', 'Slip Sense'),
      strike: pick('strike', 'Average Strike'),
      earthquake: pick('earthquake', 'Associated Earthquake'),
      fault_url: pick('fault_url', 'Fault url'),
      class: pick('class', 'Fault Class'),
      linetype: pick('linetype', 'Linetype'),
      location: pick('Location', 'location')
    };
  }

  function loadFaults() {
    if (!state.qfault) {
      faultLayer.clearLayers();
      if (map.hasLayer(faultRaster)) map.removeLayer(faultRaster);
      state.faultBounds = null;
      $('fault-note').textContent = 'Quaternary faults are hidden. Turn them back on to click a fault.';
      return;
    }
    if (map.getZoom() < 11) {
      if (!map.hasLayer(faultRaster)) faultRaster.addTo(map);
      faultLayer.clearLayers();
      state.faultBounds = null;
      $('fault-note').textContent = 'USGS Quaternary faults are drawn on the map. Zoom in to select one, or click a line to look it up.';
      return;
    }
    var bounds = map.getBounds();
    if (state.faultBounds && state.faultBounds.contains(bounds)) {
      if (map.hasLayer(faultRaster)) map.removeLayer(faultRaster);
      return;
    }
    var padded = bounds.pad(0.25);
    var token = ++state.faultToken;
    var geom = JSON.stringify({
      xmin: padded.getWest(),
      ymin: padded.getSouth(),
      xmax: padded.getEast(),
      ymax: padded.getNorth(),
      spatialReference: { wkid: 4326 }
    });
    var params = new URLSearchParams({
      geometry: geom,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'fault_name,section_name,age,slip_rate,dip_direction,slip_sense,strike,earthquake,fault_url,class,linetype,Location',
      returnGeometry: 'true',
      outSR: '4326',
      geometryPrecision: '6',
      f: 'geojson'
    });
    $('fault-note').textContent = 'Loading Quaternary faults for this view…';
    fetch(QFAULT + '/21/query?' + params.toString())
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (token !== state.faultToken) return;
        if (data.error) throw new Error(data.error.message || 'Fault query failed');
        faultLayer.clearLayers();
        var features = data.features || [];
        L.geoJSON({ type: 'FeatureCollection', features: features }, {
          style: function (feature) {
            return {
              color: S.ageColor(feature.properties && feature.properties.age),
              weight: 5,
              opacity: 0.95
            };
          },
          onEachFeature: function (feature, layer) {
            layer.on('click', function (e) {
              if (state.mode !== 'fault') return;
              L.DomEvent.stopPropagation(e);
              openFaultPopup(e.latlng, normalizeFault(feature.properties), S.linePartsFromGeometry(feature.geometry));
            });
          }
        }).eachLayer(function (layer) { faultLayer.addLayer(layer); });
        state.faultBounds = padded;
        if (map.hasLayer(faultRaster)) map.removeLayer(faultRaster);
        var extra = features.length >= 2000 ? ' Zoom in to load the rest.' : '';
        $('fault-note').textContent = features.length
          ? (features.length + ' Quaternary fault' + (features.length === 1 ? '' : 's') + ' in this view. Click a line.' + extra)
          : 'No Quaternary faults in this view. Try a preset, or zoom out.';
      })
      .catch(function (err) {
        if (token !== state.faultToken) return;
        if (!map.hasLayer(faultRaster)) faultRaster.addTo(map);
        $('fault-note').textContent = 'The fault query failed (' + err.message + '). Lines are still drawn, and a click will look the fault up.';
      });
  }

  function lookupFault(latlng) {
    var token = ++state.identifyToken;
    setStatus('Looking up the Quaternary fault under the click…');
    var b = map.getBounds();
    var size = map.getSize();
    var params = new URLSearchParams({
      geometry: latlng.lng + ',' + latlng.lat,
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all:21',
      tolerance: '14',
      mapExtent: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
      imageDisplay: Math.max(1, size.x) + ',' + Math.max(1, size.y) + ',96',
      returnGeometry: 'true',
      f: 'json'
    });
    fetch(QFAULT + '/identify?' + params.toString())
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (token !== state.identifyToken) return;
        var hit = (data.results || [])[0];
        if (!hit) {
          setStatus('No Quaternary fault under that click. Zoom in and click a colored line.');
          return;
        }
        openFaultPopup(latlng, normalizeFault(hit.attributes), S.linePartsFromGeometry(hit.geometry));
      })
      .catch(function (err) {
        if (token !== state.identifyToken) return;
        setStatus('Could not reach the USGS fault service (' + err.message + ').');
      });
  }

  function openFaultPopup(latlng, props, parts) {
    var nearest = S.nearestOnLine(latlng, parts || []);
    highlightLayer.clearLayers();
    if (parts && parts.length) {
      parts.forEach(function (part) {
        var latlngs = part.map(function (c) { return [c[1], c[0]]; });
        L.polyline(latlngs, {
          color: '#111', weight: 7, opacity: 0.55, interactive: false
        }).addTo(highlightLayer);
      });
    }
    var origin = nearest ? nearest.point : { lat: latlng.lat, lng: latlng.lng };
    var div = document.createElement('div');
    div.className = 'qpop';
    var name = document.createElement('p');
    name.className = 'name';
    name.textContent = props.section_name ? (props.fault_name + ' — ' + props.section_name) : props.fault_name;
    div.appendChild(name);
    function line(text) {
      if (!text) return;
      var p = document.createElement('p');
      p.textContent = text;
      div.appendChild(p);
    }
    line(props.age ? ('Age: ' + props.age) : 'Age: not listed');
    line(props.slip_rate ? ('Slip rate: ' + props.slip_rate) : 'Slip rate: not listed');
    if (props.slip_sense) line('Slip sense: ' + props.slip_sense);
    line(props.dip_direction ? ('Dip direction: ' + props.dip_direction) : 'Dip direction: not listed');
    if (props.strike) line('Average strike: ' + props.strike);
    if (props.class) line(CLASS_GLOSS[String(props.class).toUpperCase()] || ('Fault class: ' + props.class));
    if (props.linetype) line('Mapped as: ' + props.linetype);
    if (props.location) line(props.location);
    if (props.earthquake) line('Associated earthquake: ' + props.earthquake);
    if (props.fault_url && /^https:\/\//.test(props.fault_url)) {
      var a = document.createElement('a');
      a.href = props.fault_url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'USGS fault report';
      div.appendChild(a);
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-btn';
    btn.textContent = 'Profile perpendicular to this fault here';
    btn.addEventListener('click', function () {
      map.closePopup();
      if (!nearest) {
        setStatus('This fault has no line geometry to measure against.');
        return;
      }
      var choice = S.chooseHangingBearing(nearest.bearing, props.dip_direction);
      var lengthM = clampLength($('length').value);
      var lineEnds = S.perpendicularProfile(nearest.point, choice.footwall, choice.hanging, lengthM);
      createProfile([lineEnds.start, lineEnds.end], {
        method: 'qfault',
        fault: props,
        methodNote: choice.usedDip
          ? ('Down-dip profile across ' + props.fault_name + '. The hanging-wall end follows the mapped dip direction (' + props.dip_direction + ').')
          : ('Down-dip profile across ' + props.fault_name + '. The database has no dip direction, so check which end is uphill and use Swap ends if needed.')
      });
    });
    div.appendChild(btn);
    var hint = document.createElement('p');
    hint.textContent = 'Length ' + Math.round(clampLength($('length').value)) + ' m, centered on the fault. Footwall end is opposite the dip direction.';
    div.appendChild(hint);
    L.popup({
      maxWidth: 320,
      autoPan: true,
      autoPanPaddingTopRight: L.point(70, 24),
      autoPanPaddingBottomLeft: L.point(24, 48)
    }).setLatLng([origin.lat, origin.lng]).setContent(div).openOn(map);
    setStatus(props.fault_name + ' — use the popup button for a down-dip profile, or draw one yourself.');
  }

  /* --- drawing --- */

  function setMode(mode) {
    state.mode = mode;
    ['fault', 'profile', 'strike'].forEach(function (name) {
      $('mode-' + name).setAttribute('aria-pressed', name === mode ? 'true' : 'false');
    });
    $('hw-side-label').hidden = mode !== 'strike';
    map.getContainer().style.cursor = mode === 'fault' ? '' : 'crosshair';
    if (mode === 'profile') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    if (mode === 'fault') {
      setStatus('Click a colored Quaternary fault, then choose “Profile perpendicular to this fault here”.');
    } else if (mode === 'profile') {
      setStatus('Click vertices down dip. The first is the footwall and the last is the hanging wall. Enter or Finish samples the path. Backspace undoes a vertex.');
    } else {
      setStatus('Click two points along the scarp crest. A down-dip profile is drawn through the midpoint.');
    }
    cancelDraft();
    persist();
  }

  function onMapClick(e) {
    if (state.mode === 'fault') {
      lookupFault(e.latlng);
      return;
    }
    handleDrawClick(e.latlng);
  }

  function handleDrawClick(latlng) {
    if (state.mode === 'profile') {
      addProfileVertex(latlng);
      return;
    }
    if (!state.draft) {
      state.draft = { kind: 'strike', first: latlng };
      drawStrikeDraft(latlng, latlng);
      $('cancel-draft').hidden = false;
      setStatus('Now click the other end of the strike line.');
      return;
    }
    var first = state.draft.first;
    cancelDraft();
    if (S.haversine(first, latlng) < 20) {
      setStatus('Those two points are only a few meters apart. Click a longer line.');
      return;
    }
    var mid = S.midpoint(first, latlng);
    var strike = S.bearing(first, latlng);
    var hanging = S.sideBearing(strike, $('hw-side').value);
    var footwall = (hanging + 180) % 360;
    var ends = S.perpendicularProfile(mid, footwall, hanging, clampLength($('length').value));
    createProfile([ends.start, ends.end], {
      method: 'strike',
      methodNote: 'Down-dip profile through the midpoint of the strike line. Hanging wall is ' + $('hw-side').value + ' of the direction you drew.'
    });
  }

  function addProfileVertex(latlng) {
    if (!state.draft || state.draft.kind !== 'profile') state.draft = { kind: 'profile', vertices: [] };
    var verts = state.draft.vertices;
    if (verts.length) {
      var dist = S.haversine(verts[verts.length - 1], latlng);
      if (verts.length >= 2 && dist < 12) {
        finishProfileDraft(false);
        return;
      }
      if (dist < 8) {
        setStatus('That click is on the last vertex. Click the next point down dip, or press Finish.');
        return;
      }
    }
    verts.push({ lat: latlng.lat, lng: latlng.lng });
    $('cancel-draft').hidden = false;
    $('finish-draft').hidden = verts.length < 2;
    drawProfileDraft(latlng);
    setStatus(verts.length === 1
      ? 'Footwall vertex set. Keep clicking down dip. Enter or Finish samples the path. Backspace undoes a vertex.'
      : (verts.length + ' vertices, ' + Math.round(S.pathLength(verts)) + ' m. Click the next vertex, or Finish.'));
  }

  function finishProfileDraft(fromDoubleClick) {
    if (!state.draft || state.draft.kind !== 'profile') return;
    var verts = state.draft.vertices.map(function (v) { return { lat: v.lat, lng: v.lng }; });
    if (fromDoubleClick && verts.length >= 2 && S.haversine(verts[verts.length - 1], verts[verts.length - 2]) < 15) {
      verts.pop();
    }
    if (verts.length < 2) {
      setStatus('A profile needs at least two vertices. Click the footwall, then points down dip.');
      return;
    }
    if (S.pathLength(verts) < 20) {
      setStatus('That profile is only a few meters long. Space the vertices farther apart.');
      return;
    }
    cancelDraft();
    createProfile(verts, {
      method: 'clicks',
      methodNote: 'Profile drawn through ' + verts.length + ' vertices. The first is the footwall and the last is the hanging wall.'
    });
  }

  function undoVertex() {
    if (!state.draft || state.draft.kind !== 'profile' || !state.draft.vertices.length) {
      cancelDraft();
      return;
    }
    state.draft.vertices.pop();
    if (!state.draft.vertices.length) {
      cancelDraft();
      setStatus('Vertex removed. Click the footwall to start the profile.');
      return;
    }
    $('finish-draft').hidden = state.draft.vertices.length < 2;
    drawProfileDraft(null);
    setStatus(state.draft.vertices.length + ' vertices. Click the next one, or Finish.');
  }

  function onMouseMove(e) {
    if (!state.draft) return;
    if (state.draft.kind === 'profile') drawProfileDraft(e.latlng);
    else if (state.draft.first) drawStrikeDraft(state.draft.first, e.latlng);
  }

  function drawProfileDraft(cursor) {
    draftLayer.clearLayers();
    var verts = state.draft && state.draft.vertices ? state.draft.vertices : [];
    verts.forEach(function (v, i) {
      var label = i === 0 ? 'FW' : String(i + 1);
      var color = i === 0 ? '#1b7f4e' : '#003f7f';
      L.marker([v.lat, v.lng], { icon: endIcon(label, color), interactive: false }).addTo(draftLayer);
    });
    var line = verts.map(function (v) { return [v.lat, v.lng]; });
    if (cursor && verts.length) line.push([cursor.lat, cursor.lng]);
    if (line.length >= 2) {
      L.polyline(line, { color: '#003f7f', weight: 3, dashArray: '6 6', interactive: false }).addTo(draftLayer);
    }
  }

  function drawStrikeDraft(a, b) {
    draftLayer.clearLayers();
    L.marker([a.lat, a.lng], { icon: endIcon('1', '#1b7f4e'), interactive: false }).addTo(draftLayer);
    L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
      color: '#003f7f', weight: 3, dashArray: '6 6', interactive: false
    }).addTo(draftLayer);
  }

  function cancelDraft() {
    state.draft = null;
    draftLayer.clearLayers();
    $('cancel-draft').hidden = true;
    if ($('finish-draft')) $('finish-draft').hidden = true;
  }

  function endIcon(text, color) {
    return L.divIcon({
      className: 'end-icon',
      html: '<span style="background:' + color + '">' + text + '</span>',
      iconSize: [28, 18],
      iconAnchor: [14, 9]
    });
  }

  function clampLength(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 600;
    return Math.max(40, Math.min(20000, n));
  }

  function createProfile(vertices, extra) {
    var clean = vertices.map(function (v) { return { lat: v.lat, lng: v.lng }; });
    var start = clean[0];
    var end = clean[clean.length - 1];
    var name = ($('group-name').value || '').trim() || S.suggestGroupName(state.profiles.map(function (p) { return p.group; }));
    var profile = {
      id: 'sp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      group: name,
      notes: '',
      antithetic: false,
      include: true,
      dip: clampDip($('dip').value),
      spacing: Number($('spacing').value) || 2,
      lengthM: S.pathLength(clean),
      elevationSource: '',
      fault: extra.fault || null,
      method: extra.method || '',
      methodNote: extra.methodNote || '',
      fits: {},
      samples: [],
      vertices: clean,
      start: { lat: start.lat, lng: start.lng },
      end: { lat: end.lat, lng: end.lng }
    };
    state.profiles.push(profile);
    state.activeId = profile.id;
    state.pick = null;
    state.pickX0 = null;
    var names = state.profiles.map(function (p) { return p.group; });
    $('group-name').value = S.suggestGroupName(names);
    persist();
    drawProfiles();
    renderSide();
    renderTable(true);
    sampleProfile(profile);
    map.fitBounds(boundsOf(clean).pad(0.4));
  }

  function boundsOf(vertices) {
    return L.latLngBounds(vertices.map(function (v) { return [v.lat, v.lng]; }));
  }

  function drawProfiles() {
    profileLayer.clearLayers();
    state.profiles.forEach(function (p) {
      var on = p.id === state.activeId;
      var verts = S.verticesOf(p);
      L.polyline(verts.map(function (v) { return [v.lat, v.lng]; }), {
        pane: 'profiles',
        color: on ? '#003f7f' : '#c44900',
        weight: on ? 4 : 3,
        interactive: true
      }).bindTooltip(escapeHtml(p.group), { sticky: true }).on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        state.activeId = p.id;
        persist();
        refresh();
      }).addTo(profileLayer);
      verts.forEach(function (v, i) {
        if (i === 0) {
          L.marker([v.lat, v.lng], { pane: 'profiles', icon: endIcon('FW', '#1b7f4e'), interactive: false }).addTo(profileLayer);
        } else if (i === verts.length - 1) {
          L.marker([v.lat, v.lng], { pane: 'profiles', icon: endIcon('HW', '#9b2226'), interactive: false }).addTo(profileLayer);
        } else {
          L.circleMarker([v.lat, v.lng], {
            pane: 'profiles', radius: 4, color: '#003f7f', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false
          }).addTo(profileLayer);
        }
      });
    });
  }

  /* --- elevations --- */

  function toLngLat(x, y) {
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return { lng: x, lat: y };
    var R = 6378137;
    return {
      lng: (x / R) * 180 / Math.PI,
      lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI
    };
  }

  function parseElevation(value) {
    var z = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(z) || z < -200 || z > 9000) return null;
    return z;
  }

  function sampleProfile(profile) {
    var token = ++state.sampleToken;
    var spacing = profile.spacing || 2;
    showProgress('Requesting elevations from USGS 3DEP…', null);
    setStatus('Sampling ' + profile.group + ' about every ' + spacing + ' m…');
    var signal = { aborted: false };
    state.abortSample = function () { signal.aborted = true; };
    var vertices = S.verticesOf(profile);
    getSamples(vertices, spacing, signal)
      .then(function (raw) {
        if (token !== state.sampleToken || signal.aborted) return null;
        var samples = S.downsample(S.projectSamples(raw, vertices), spacing);
        if (samples.length < 2) throw new Error('3DEP returned no usable elevations on this line');
        return { samples: samples, source: 'USGS 3DEP getSamples' };
      })
      .catch(function (err) {
        if (token !== state.sampleToken || signal.aborted) return null;
        showProgress('Line sample failed. Querying points from EPQS…', 0);
        setStatus('The 3DEP line sample did not finish (' + err.message + '). Trying point-by-point elevations.');
        return epqsLine(vertices, spacing, signal, function (done, total) {
          if (token !== state.sampleToken) return;
          showProgress('USGS EPQS ' + done + ' / ' + total, done / total);
        });
      })
      .then(function (result) {
        if (!result || token !== state.sampleToken || signal.aborted) {
          if (signal.aborted) {
            hideProgress();
            setStatus('Elevation sampling cancelled.');
          }
          return;
        }
        profile.samples = result.samples;
        profile.elevationSource = result.source;
        profile.lengthM = S.pathLength(S.verticesOf(profile));
        profile.sampleError = '';
        hideProgress();
        var note = S.resolutionNote(result.samples);
        setStatus(profile.group + ': ' + result.samples.length + ' elevations from ' + result.source + (note ? '. ' + note + '.' : '.'));
        persist();
        refresh();
      })
      .catch(function (err) {
        if (token !== state.sampleToken) return;
        hideProgress();
        profile.sampleError = err.message;
        setStatus('Elevations did not load: ' + err.message + ' Use Reload elevations to try again.');
        refresh();
      });
  }

  function getSamples(vertices, spacingM, signal) {
    var midLat = 0;
    vertices.forEach(function (v) { midLat += v.lat; });
    midLat = midLat / vertices.length;
    var mDeg = Math.min(111132, Math.abs(111320 * Math.cos(midLat * Math.PI / 180)) || 111132);
    var deg = Math.max(1, spacingM) / mDeg;
    var geometry = {
      paths: [vertices.map(function (v) { return [v.lng, v.lat]; })],
      spatialReference: { wkid: 4326 }
    };
    var params = new URLSearchParams({
      geometry: JSON.stringify(geometry),
      geometryType: 'esriGeometryPolyline',
      sampleDistance: String(deg),
      returnFirstValueOnly: 'false',
      interpolation: 'RSP_BilinearInterpolation',
      f: 'json'
    });
    var timedOut = false;
    var timer = window.setTimeout(function () { timedOut = true; }, 28000);
    return fetch(SAMPLES + '?' + params.toString()).then(function (res) {
      window.clearTimeout(timer);
      if (signal.aborted) throw new Error('cancelled');
      if (timedOut) throw new Error('timed out');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (data.error) throw new Error(data.error.message || '3DEP error');
      var raw = [];
      (data.samples || []).forEach(function (s) {
        var z = parseElevation(s.value);
        var loc = s.location || {};
        if (z == null || !isFinite(loc.x) || !isFinite(loc.y)) return;
        var ll = toLngLat(loc.x, loc.y);
        raw.push({ lng: ll.lng, lat: ll.lat, z: z, resolution: parseFloat(s.resolution) });
      });
      if (raw.length < 2) throw new Error('no elevations');
      return raw;
    }).catch(function (err) {
      window.clearTimeout(timer);
      throw err;
    });
  }

  function epqsPoint(lat, lng, signal) {
    var url = EPQS + '?x=' + encodeURIComponent(lng) + '&y=' + encodeURIComponent(lat) + '&units=Meters&wkid=4326';
    function once() {
      if (signal.aborted) return Promise.reject(new Error('cancelled'));
      return fetch(url).then(function (res) {
        if (res.status === 429) {
          var wait = Math.min(8, parseInt(res.headers.get('Retry-After') || '2', 10) || 2);
          return sleep(wait * 1000).then(function () {
            if (signal.aborted) throw new Error('cancelled');
            return fetch(url);
          });
        }
        return res;
      }).then(function (res) {
        if (!res.ok) throw new Error('EPQS HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        var z = parseElevation(data.value);
        if (z == null) throw new Error('NoData');
        return { z: z, resolution: parseFloat(data.resolution) };
      });
    }
    return once().catch(function () { return once(); });
  }

  function epqsLine(vertices, spacingM, signal, onProgress) {
    var pts = S.pointsAlong(vertices, spacingM);
    var results = new Array(pts.length);
    var cursor = 0;
    var done = 0;
    var failed = 0;
    function worker() {
      if (cursor >= pts.length) return Promise.resolve();
      var i = cursor++;
      return epqsPoint(pts[i].lat, pts[i].lng, signal).then(function (hit) {
        results[i] = {
          lat: pts[i].lat,
          lng: pts[i].lng,
          d: pts[i].d,
          z: hit.z,
          resolution: hit.resolution
        };
      }).catch(function () {
        failed += 1;
        results[i] = null;
      }).then(function () {
        done += 1;
        onProgress(done, pts.length);
        if (signal.aborted) throw new Error('cancelled');
        return worker();
      });
    }
    return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
      var samples = results.filter(Boolean);
      if (samples.length < 2 || failed > pts.length / 2) {
        throw new Error('EPQS failed on ' + failed + ' of ' + pts.length + ' points');
      }
      samples.sort(function (a, b) { return a.d - b.d; });
      return { samples: S.downsample(samples, spacingM), source: 'USGS EPQS point fallback' };
    });
  }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  /* --- chart and readouts --- */

  function nearestSample(samples, d) {
    var best = samples[0];
    var bestD = Infinity;
    for (var i = 0; i < samples.length; i++) {
      var dd = Math.abs(samples[i].d - d);
      if (dd < bestD) { best = samples[i]; bestD = dd; }
    }
    return best;
  }

  function ensureChart() {
    if (chart) return;
    var shade = {
      id: 'scarpShade',
      beforeDatasetsDraw: function (c) {
        var profile = active();
        if (!profile || !profile.fits) return;
        var colors = { upper: 'rgba(27,127,78,0.13)', lower: 'rgba(188,108,37,0.14)', face: 'rgba(155,34,38,0.16)' };
        Object.keys(colors).forEach(function (key) {
          var range = profile.fits[key];
          if (!range) return;
          var x0 = c.scales.x.getPixelForValue(Math.min(range.x0, range.x1));
          var x1 = c.scales.x.getPixelForValue(Math.max(range.x0, range.x1));
          var area = c.chartArea;
          c.ctx.save();
          c.ctx.fillStyle = colors[key];
          c.ctx.fillRect(x0, area.top, x1 - x0, area.bottom - area.top);
          c.ctx.restore();
        });
      },
      afterDatasetsDraw: function (c) {
        var m = c.$measure;
        if (!m || !m.complete) return;
        var x = c.scales.x.getPixelForValue(m.xm);
        var y = (c.scales.y.getPixelForValue(m.zU) + c.scales.y.getPixelForValue(m.zL)) / 2;
        c.ctx.save();
        c.ctx.fillStyle = '#111';
        c.ctx.font = '12px system-ui, sans-serif';
        c.ctx.fillText('throw ' + m.throwM.toFixed(1) + ' m', x + 6, y);
        c.ctx.restore();
      }
    };
    chart = new Chart($('chart'), {
      type: 'line',
      data: { datasets: [] },
      plugins: [shade],
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        onClick: function (evt) { onChartClick(evt); },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { filter: function (item) { return !!item.text; } }
          }
        },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Distance down dip (m)' } },
          y: { type: 'linear', title: { display: true, text: 'Elevation (m)' } }
        }
      }
    });
  }

  function segmentLine(fit, x0, x1) {
    if (!fit) return [];
    return [
      { x: x0, y: fit.m * x0 + fit.b },
      { x: x1, y: fit.m * x1 + fit.b }
    ];
  }

  function renderChart() {
    var profile = active();
    var box = $('chart-box');
    if (!profile || !profile.samples || profile.samples.length < 2) {
      box.classList.remove('has-data');
      if (chart) {
        chart.data.datasets = [];
        chart.update('none');
      }
      return;
    }
    ensureChart();
    box.classList.add('has-data');
    var m = S.measure(profile);
    var samples = profile.samples;
    var xMax = samples[samples.length - 1].d;
    var data = samples.map(function (s) { return { x: s.d, y: s.z }; });
    function dashed(fit) {
      if (!fit || !m.complete) return segmentLine(fit, fit ? fit.x0 : 0, fit ? fit.x1 : 0);
      var pad = Math.max(8, (fit.x1 - fit.x0) * 0.2);
      var a = Math.max(0, Math.min(fit.x0, m.xm) - pad);
      var b = Math.max(fit.x1, m.xm) + pad;
      return segmentLine(fit, a, b);
    }
    var throwLine = m.complete ? [{ x: m.xm, y: m.zU }, { x: m.xm, y: m.zL }] : [];
    var mark = [];
    if (state.pickX0 != null) mark = [{ x: state.pickX0, y: nearestSample(samples, state.pickX0).z }];
    chart.data.datasets = [
      { label: 'Elevation', data: data, borderColor: '#1d4e89', backgroundColor: '#1d4e89', pointRadius: 0, borderWidth: 1.6, tension: 0 },
      { label: '', data: m.upper ? dashed(m.upper) : [], borderColor: 'rgba(27,127,78,0.55)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
      { label: '', data: m.lower ? dashed(m.lower) : [], borderColor: 'rgba(188,108,37,0.7)', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 },
      { label: m.upper ? 'Upper surface' : '', data: m.upper ? segmentLine(m.upper, m.upper.x0, m.upper.x1) : [], borderColor: '#1b7f4e', pointRadius: 0, borderWidth: 3 },
      { label: m.lower ? 'Lower surface' : '', data: m.lower ? segmentLine(m.lower, m.lower.x0, m.lower.x1) : [], borderColor: '#bc6c25', pointRadius: 0, borderWidth: 3 },
      { label: m.face ? 'Scarp face' : '', data: m.face ? segmentLine(m.face, m.face.x0, m.face.x1) : [], borderColor: '#9b2226', pointRadius: 0, borderWidth: 3 },
      { label: m.complete ? 'Throw' : '', data: throwLine, borderColor: '#111', pointRadius: 0, borderWidth: 2 },
      { label: '', type: 'scatter', data: mark, pointRadius: 5, pointBackgroundColor: '#003f7f', borderColor: '#003f7f' }
    ];
    chart.$measure = m;
    applyVerticalExaggeration(profile, m);
  }

  function applyVerticalExaggeration(profile, measure) {
    var samples = profile.samples;
    var xMax = Math.max(1, samples[samples.length - 1].d);
    var zmin = Infinity;
    var zmax = -Infinity;
    samples.forEach(function (s) {
      if (s.z < zmin) zmin = s.z;
      if (s.z > zmax) zmax = s.z;
    });
    if (measure && measure.complete) {
      zmin = Math.min(zmin, measure.zU, measure.zL);
      zmax = Math.max(zmax, measure.zU, measure.zL);
    }
    var dataSpan = Math.max(2, zmax - zmin);
    var ySpan = dataSpan * 1.12;
    var ve = Math.max(1, Number($('ve').value) || 4);
    var box = $('chart-box');
    var plotW = Math.max(220, box.clientWidth - 64);
    var plotH = ve * plotW * ySpan / xMax;
    box.style.height = Math.max(220, Math.min(540, plotH + 86)) + 'px';
    chart.options.scales.y.min = (zmin + zmax) / 2 - ySpan / 2;
    chart.options.scales.y.max = (zmin + zmax) / 2 + ySpan / 2;
    chart.options.scales.x.min = 0;
    chart.options.scales.x.max = xMax;
    chart.update('none');
    var area = chart.chartArea;
    var W = Math.max(1, area.right - area.left);
    var H = Math.max(1, area.bottom - area.top);
    var actual = (xMax / W) / (ySpan / H);
    $('ve-label').textContent = (isFinite(actual) ? actual.toFixed(1) : ve.toFixed(1)) + '×';
  }

  function onChartClick(evt) {
    var profile = active();
    if (!profile || profile.samples.length < 2) return;
    if (!state.pick) {
      setStatus('Choose Upper surface, Lower surface, or Scarp face, then click the plot twice.');
      return;
    }
    var d = chart.scales.x.getValueForPixel(evt.x);
    if (!isFinite(d)) return;
    var sample = nearestSample(profile.samples, d);
    if (state.pickX0 == null) {
      state.pickX0 = sample.d;
      setStatus('Click the other end of the ' + pickName(state.pick) + '.');
      renderChart();
      return;
    }
    var x0 = state.pickX0;
    var x1 = sample.d;
    state.pickX0 = null;
    if (Math.abs(x1 - x0) < 0.4) {
      setStatus('Those clicks are the same point. Click the two ends of the stretch.');
      renderChart();
      return;
    }
    profile.fits[state.pick] = { x0: Math.min(x0, x1), x1: Math.max(x0, x1) };
    var fit = S.measure(profile)[state.pick];
    if (!fit) {
      setStatus('That stretch needs at least two elevation samples. Click a longer piece of the profile.');
      delete profile.fits[state.pick];
    } else {
      setStatus(pickName(state.pick) + ' fit from ' + fit.x0.toFixed(0) + ' m to ' + fit.x1.toFixed(0) + ' m.');
    }
    persist();
    refresh();
  }

  function pickName(key) {
    return key === 'upper' ? 'upper surface' : (key === 'lower' ? 'lower surface' : 'scarp face');
  }

  function renderSide() {
    var profile = active();
    $('measuring').textContent = profile ? ('Measuring: ' + profile.group) : 'Profile';
    $('method-note').textContent = profile && profile.methodNote ? profile.methodNote : '';
    suspend = true;
    if (profile) {
      $('dip').value = clampDip(profile.dip);
      $('antithetic').checked = !!profile.antithetic;
      $('include').checked = profile.include !== false;
      $('notes').value = profile.notes || '';
    }
    suspend = false;
    ['upper', 'lower', 'face'].forEach(function (key) {
      var btn = $('pick-' + key);
      var fit = profile && profile.fits && profile.fits[key];
      btn.setAttribute('aria-pressed', state.pick === key ? 'true' : 'false');
      var base = key === 'upper' ? 'Upper surface' : (key === 'lower' ? 'Lower surface' : 'Scarp face');
      btn.textContent = fit ? (base + ' ' + Math.round(Math.min(fit.x0, fit.x1)) + '–' + Math.round(Math.max(fit.x0, fit.x1)) + ' m') : base;
    });
    var m = profile ? S.measure(profile) : null;
    $('m-throw').textContent = m && m.complete ? fmt(m.throwM) + ' m' : '—';
    $('m-heave').textContent = m && m.complete ? fmt(m.heave) + ' m' : '—';
    $('m-slip').textContent = m && m.complete ? fmt(m.netSlip) + ' m' : '—';
    $('m-height').textContent = m && m.complete ? fmt(m.scarpHeight) + ' m' : '—';
    $('m-face').textContent = m && m.face ? slopeText(m.faceSlope) : '—';
    $('m-far').textContent = m && m.complete ? slopeText(m.farFieldSlope) : '—';
    var bits = [];
    if (m && m.upper && m.lower) {
      bits.push('Upper slope ' + slopeText(m.upperSlope) + ', lower slope ' + slopeText(m.lowerSlope) + '.');
    }
    if (m && m.complete) {
      bits.push('Heave = throw / tan(' + m.dip + '°), net slip = throw / sin(' + m.dip + '°).');
      if (m.heightNote) bits.push(m.heightNote);
      if (m.throwM < 0) {
        bits.push('Throw is negative, so the upper line is below the lower line. Swap ends, or swap the two surface picks. Use Antithetic only for a scarp that faces the other way and has a positive throw.');
      } else if (profile.antithetic) {
        bits.push('Counted in the total as ' + fmt(-m.throwM) + ' m of throw and ' + fmt(-m.heave) + ' m of heave.');
      }
      if (m.upper && m.upper.rmse > 3) bits.push('Upper surface scatters ±' + m.upper.rmse.toFixed(1) + ' m around the line.');
      if (m.lower && m.lower.rmse > 3) bits.push('Lower surface scatters ±' + m.lower.rmse.toFixed(1) + ' m around the line.');
    } else if (profile && profile.samples.length >= 2) {
      bits.push('Mark the upper surface, the lower surface, and the scarp face.');
    } else if (profile && profile.sampleError) {
      bits.push(profile.sampleError);
    }
    $('metric-note').textContent = bits.join(' ');
    var hint = 'Click Upper, Lower, or Scarp face, then click the two ends of that stretch on the plot.';
    if (state.pick && state.pickX0 == null) hint = 'Click the first end of the ' + pickName(state.pick) + '.';
    if (state.pick && state.pickX0 != null) hint = 'Click the other end of the ' + pickName(state.pick) + '.';
    $('pick-hint').textContent = hint;
  }

  function renderTable(force) {
    var tbody = $('rows');
    var el = document.activeElement;
    var typing = !force && el && tbody.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));
    if (!typing) {
      tbody.textContent = '';
      state.profiles.forEach(function (p) {
        var m = S.measure(p);
        var tr = document.createElement('tr');
        if (p.id === state.activeId) tr.className = 'active';
        tr.appendChild(checkCell(p, 'include', p.include !== false));
        tr.appendChild(checkCell(p, 'antithetic', !!p.antithetic));
        tr.appendChild(textCell(p, 'group', p.group));
        tr.appendChild(td(fmt(p.lengthM, 0)));
        tr.appendChild(td(m.complete ? fmt(m.throwM) : '—'));
        tr.appendChild(td(m.complete ? fmt(m.heave) : '—'));
        tr.appendChild(dipCell(p));
        tr.appendChild(notesCell(p));
        var actions = document.createElement('td');
        var zoom = document.createElement('button');
        zoom.type = 'button';
        zoom.textContent = 'Zoom';
        zoom.addEventListener('click', function () {
          state.activeId = p.id;
          map.fitBounds(boundsOf(S.verticesOf(p)).pad(0.45));
          persist();
          refresh();
        });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Delete';
        del.addEventListener('click', function () {
          state.profiles = state.profiles.filter(function (item) { return item.id !== p.id; });
          if (state.activeId === p.id) state.activeId = state.profiles.length ? state.profiles[state.profiles.length - 1].id : null;
          persist();
          refresh();
        });
        actions.appendChild(zoom);
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(del);
        tr.appendChild(actions);
        tr.addEventListener('click', function (ev) {
          if (ev.target.closest('input, textarea, button')) return;
          state.activeId = p.id;
          persist();
          refresh();
        });
        tbody.appendChild(tr);
      });
    }
    var t = S.totals(state.profiles);
    $('total-label').textContent = t.n ? ('Total of ' + t.n + ' linked scarp' + (t.n === 1 ? '' : 's')) : 'Total of linked scarps';
    $('total-throw').textContent = t.n ? fmt(t.throwM) : '—';
    $('total-heave').textContent = t.n ? fmt(t.heave) : '—';
    $('total-note').textContent = t.n ? 'Antithetic scarps subtracted. Unchecked rows left out.' : '';
  }

  function td(text) {
    var cell = document.createElement('td');
    cell.textContent = text;
    return cell;
  }

  function checkCell(profile, key, checked) {
    var cell = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('change', function () {
      profile[key] = input.checked;
      state.activeId = profile.id;
      persist();
      refresh();
    });
    cell.appendChild(input);
    return cell;
  }

  function textCell(profile, key, value) {
    var cell = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    input.maxLength = 80;
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('input', function () {
      profile[key] = input.value;
      state.activeId = profile.id;
      if (key === 'group') $('measuring').textContent = 'Measuring: ' + (input.value || 'Untitled');
      persist();
      drawProfiles();
    });
    cell.appendChild(input);
    return cell;
  }

  function notesCell(profile) {
    var cell = document.createElement('td');
    var input = document.createElement('textarea');
    input.value = profile.notes || '';
    input.maxLength = 500;
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('input', function () {
      profile.notes = input.value;
      state.activeId = profile.id;
      if (profile.id === state.activeId) $('notes').value = input.value;
      persist();
    });
    cell.appendChild(input);
    return cell;
  }

  function dipCell(profile) {
    var cell = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '89';
    input.step = '1';
    input.value = String(clampDip(profile.dip));
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });
    input.addEventListener('change', function () {
      profile.dip = clampDip(input.value);
      input.value = String(profile.dip);
      state.activeId = profile.id;
      persist();
      refresh();
    });
    cell.appendChild(input);
    return cell;
  }

  function clampDip(value) {
    var n = Number(value);
    if (!isFinite(n)) n = 60;
    return Math.max(1, Math.min(89, Math.round(n)));
  }

  function refresh() {
    drawProfiles();
    renderSide();
    renderChart();
    renderTable(false);
  }

  /* --- search, import, export --- */

  function goTo(lat, lng, zoom) {
    map.setView([lat, lng], zoom || Math.max(map.getZoom(), 13));
  }

  function parseCoord(text) {
    var m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    var a = parseFloat(m[1]);
    var b = parseFloat(m[2]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
    return null;
  }

  function geocode(q) {
    var esri = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&countryCode=USA&singleLine=' + encodeURIComponent(q);
    return fetch(esri).then(function (res) {
      if (!res.ok) throw new Error('search failed');
      return res.json();
    }).then(function (data) {
      var c = (data.candidates || [])[0];
      if (!c || !c.location) throw new Error('no match');
      return { lat: c.location.y, lng: c.location.x, label: c.address };
    }).catch(function () {
      return fetch('https://photon.komoot.io/api/?limit=1&q=' + encodeURIComponent(q)).then(function (res) {
        if (!res.ok) throw new Error('search failed');
        return res.json();
      }).then(function (data) {
        var f = (data.features || [])[0];
        if (!f) throw new Error('no match');
        return {
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0],
          label: f.properties.name || q
        };
      });
    });
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function wire() {
    document.querySelectorAll('.presets button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        goTo(parseFloat(btn.dataset.lat), parseFloat(btn.dataset.lng), parseInt(btn.dataset.zoom, 10));
      });
    });
    $('search-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = $('search-q').value.trim();
      if (!q) return;
      var coord = parseCoord(q);
      if (coord) {
        goTo(coord.lat, coord.lng, 14);
        setStatus('Moved to ' + coord.lat.toFixed(4) + ', ' + coord.lng.toFixed(4) + '.');
        return;
      }
      setStatus('Searching for “' + q + '”…');
      geocode(q).then(function (hit) {
        goTo(hit.lat, hit.lng, 13);
        setStatus(hit.label);
      }).catch(function () {
        setStatus('No place found. Try a preset, or type latitude, longitude.');
      });
    });
    $('basemap').value = state.basemap;
    $('basemap').addEventListener('change', function () { setBasemap($('basemap').value); });
    $('spacing').value = String(state.spacing);
    $('spacing').addEventListener('change', function () {
      state.spacing = Number($('spacing').value) || 2;
      var p = active();
      if (p) p.spacing = state.spacing;
      persist();
    });
    $('length').value = String(state.lengthM);
    $('length').addEventListener('change', function () {
      state.lengthM = clampLength($('length').value);
      $('length').value = String(state.lengthM);
      persist();
    });
    $('group-name').value = state.nextName;
    $('group-name').addEventListener('input', persist);
    $('hw-side').value = state.hwSide;
    $('hw-side').addEventListener('change', function () {
      state.hwSide = $('hw-side').value;
      persist();
    });
    $('qfault-toggle').checked = state.qfault;
    $('qfault-toggle').addEventListener('change', function () {
      state.qfault = $('qfault-toggle').checked;
      state.faultBounds = null;
      persist();
      loadFaults();
    });
    $('mode-fault').addEventListener('click', function () { setMode('fault'); });
    $('mode-profile').addEventListener('click', function () { setMode('profile'); });
    $('mode-strike').addEventListener('click', function () { setMode('strike'); });
    $('cancel-draft').addEventListener('click', function () {
      cancelDraft();
      setStatus('Drawing cancelled.');
    });
    $('finish-draft').addEventListener('click', function () { finishProfileDraft(false); });
    $('cancel-sample').addEventListener('click', function () {
      if (state.abortSample) state.abortSample();
      state.sampleToken += 1;
      hideProgress();
      setStatus('Elevation sampling cancelled.');
    });
    ['upper', 'lower', 'face'].forEach(function (key) {
      $('pick-' + key).addEventListener('click', function () {
        state.pick = key;
        state.pickX0 = null;
        renderSide();
        setStatus('Click the two ends of the ' + pickName(key) + ' on the plot.');
      });
    });
    $('clear-fits').addEventListener('click', function () {
      var p = active();
      if (!p) return;
      p.fits = {};
      state.pickX0 = null;
      persist();
      refresh();
    });
    $('dip').addEventListener('change', function () {
      if (suspend) return;
      var p = active();
      var dip = clampDip($('dip').value);
      $('dip').value = String(dip);
      if (p) {
        p.dip = dip;
        persist();
        refresh();
      }
    });
    $('antithetic').addEventListener('change', function () {
      if (suspend) return;
      var p = active();
      if (!p) return;
      p.antithetic = $('antithetic').checked;
      persist();
      refresh();
    });
    $('include').addEventListener('change', function () {
      if (suspend) return;
      var p = active();
      if (!p) return;
      p.include = $('include').checked;
      persist();
      refresh();
    });
    $('notes').addEventListener('input', function () {
      if (suspend) return;
      var p = active();
      if (!p) return;
      p.notes = $('notes').value;
      persist();
      var row = document.querySelector('#rows tr.active textarea');
      if (row && row !== document.activeElement) row.value = p.notes;
    });
    $('swap-ends').addEventListener('click', function () {
      var p = active();
      if (!p) return;
      S.swapEnds(p);
      persist();
      refresh();
      setStatus('Ends swapped. The profile now starts at the other end.');
    });
    $('retry-elev').addEventListener('click', function () {
      var p = active();
      if (!p) return;
      p.spacing = Number($('spacing').value) || p.spacing || 2;
      sampleProfile(p);
    });
    $('ve').value = String(state.ve);
    $('ve').addEventListener('input', function () {
      state.ve = Number($('ve').value) || 4;
      persist();
      if (active()) renderChart();
    });
    $('export-csv').addEventListener('click', function () {
      download('scarp-profiles.csv', S.toCSV(state.profiles), 'text/csv');
      setStatus('Exported ' + state.profiles.length + ' scarps as CSV.');
    });
    $('export-geojson').addEventListener('click', function () {
      download('scarp-profiles.geojson', JSON.stringify(S.toGeoJSON(state.profiles)), 'application/geo+json');
      setStatus('Exported ' + state.profiles.length + ' profiles as GeoJSON.');
    });
    $('import-file').addEventListener('change', function () {
      var file = $('import-file').files && $('import-file').files[0];
      $('import-file').value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(String(reader.result));
          var incoming = S.fromGeoJSON(data);
          if (!incoming.length) throw new Error('no profile lines');
          if ($('import-replace').checked) state.profiles = [];
          incoming.forEach(function (p) {
            var idx = -1;
            for (var i = 0; i < state.profiles.length; i++) {
              if (state.profiles[i].id === p.id) idx = i;
            }
            if (idx >= 0) state.profiles[idx] = p;
            else state.profiles.push(p);
          });
          state.activeId = incoming[incoming.length - 1].id;
          $('group-name').value = S.suggestGroupName(state.profiles.map(function (p) { return p.group; }));
          persist();
          refresh();
          var needs = incoming.filter(function (p) { return p.needsSample; });
          setStatus('Imported ' + incoming.length + ' profile' + (incoming.length === 1 ? '' : 's') + '.');
          if (needs.length) {
            setStatus('Imported ' + incoming.length + ' profiles. Sampling elevations for ' + needs.length + ' that had no stored samples.');
            sampleNext(needs, 0);
          }
          map.fitBounds(boundsOf(S.verticesOf(incoming[0])).pad(0.4));
        } catch (err) {
          setStatus('That file is not a profile GeoJSON (' + err.message + ').');
        }
      };
      reader.readAsText(file);
    });
    $('clear-all').addEventListener('click', function () {
      if (!state.profiles.length) return;
      if (!window.confirm('Clear every scarp measurement in this browser?')) return;
      state.profiles = [];
      state.activeId = null;
      $('group-name').value = 'Range front';
      persist();
      refresh();
      setStatus('Measurements cleared.');
    });
    window.addEventListener('resize', function () {
      if (chart && active()) renderChart();
    });
  }

  function sampleNext(list, index) {
    if (index >= list.length) return;
    var profile = null;
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === list[index].id) profile = state.profiles[i];
    }
    if (!profile) {
      sampleNext(list, index + 1);
      return;
    }
    var previous = state.sampleToken;
    sampleProfile(profile);
    var watch = setInterval(function () {
      if (state.sampleToken !== previous && $('progress').hidden) {
        clearInterval(watch);
        sampleNext(list, index + 1);
      }
    }, 400);
  }

  load();
  initMap();
  setBasemap(state.basemap);
  wire();
  setMode(state.mode);
  drawProfiles();
  renderSide();
  renderTable(true);
  renderChart();
  loadFaults();
})();
