/* Pinch, drag, and tap viewer for the unreferenced scan. */
(function (root) {
  function createViewer(el, img) {
    var tx = 0;
    var ty = 0;
    var scale = 1;
    var minScale = 0.1;
    var maxScale = 8;
    var pointers = new Map();
    var tapFn = function () {};
    var dragFn = function () {};
    var markers = [];
    var pinDrag = null;

    function apply() {
      img.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + scale + ")";
      markers.forEach(place);
    }

    function fit() {
      var rect = el.getBoundingClientRect();
      if (!img.naturalWidth || !rect.width) return;
      var sx = rect.width / img.naturalWidth;
      var sy = rect.height / img.naturalHeight;
      scale = Math.min(sx, sy) * 0.98;
      minScale = scale * 0.6;
      maxScale = Math.max(6, 2 / scale);
      tx = (rect.width - img.naturalWidth * scale) / 2;
      ty = (rect.height - img.naturalHeight * scale) / 2;
      apply();
    }

    function clientToImage(cx, cy) {
      var rect = el.getBoundingClientRect();
      return {
        x: (cx - rect.left - tx) / scale,
        y: (cy - rect.top - ty) / scale
      };
    }

    function imageToClient(x, y) {
      var rect = el.getBoundingClientRect();
      return { x: rect.left + tx + x * scale, y: rect.top + ty + y * scale };
    }

    function zoomAt(cx, cy, next) {
      next = Math.min(maxScale, Math.max(minScale, next));
      var before = clientToImage(cx, cy);
      scale = next;
      var rect = el.getBoundingClientRect();
      tx = cx - rect.left - before.x * scale;
      ty = cy - rect.top - before.y * scale;
      apply();
    }

    function place(marker) {
      marker.el.style.left = (tx + marker.x * scale) + "px";
      marker.el.style.top = (ty + marker.y * scale) + "px";
    }

    function setMarkers(list) {
      markers.forEach(function (m) { m.el.remove(); });
      markers = list.map(function (item) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "pin" + (item.pending ? " pending" : "");
        button.textContent = item.label;
        button.setAttribute("aria-label", item.pending ? "Scan point, waiting for a map location" : "Control point " + item.label + ". Drag to move.");
        button.addEventListener("pointerdown", function (ev) {
          ev.stopPropagation();
          ev.preventDefault();
          pinDrag = { id: item.id, pointer: ev.pointerId, moved: false, x: ev.clientX, y: ev.clientY };
          button.setPointerCapture(ev.pointerId);
        });
        button.addEventListener("pointermove", function (ev) {
          if (!pinDrag || pinDrag.pointer !== ev.pointerId) return;
          if (Math.hypot(ev.clientX - pinDrag.x, ev.clientY - pinDrag.y) > 4) pinDrag.moved = true;
          var p = clientToImage(ev.clientX, ev.clientY);
          item.x = Math.min(img.naturalWidth, Math.max(0, p.x));
          item.y = Math.min(img.naturalHeight, Math.max(0, p.y));
          markerSync(item);
          place(marker);
          if (pinDrag.moved) dragFn(item.id, item.x, item.y, "move");
        });
        button.addEventListener("pointerup", function (ev) {
          if (!pinDrag || pinDrag.pointer !== ev.pointerId) return;
          if (pinDrag.moved) dragFn(item.id, item.x, item.y, "end");
          pinDrag = null;
        });
        el.appendChild(button);
        var marker = { id: item.id, x: item.x, y: item.y, el: button };
        return marker;
      });
      function markerSync(item) {
        var found = markers.find(function (m) { return m.id === item.id; });
        if (found) { found.x = item.x; found.y = item.y; }
      }
      apply();
    }

    var gesture = null;
    el.addEventListener("pointerdown", function (ev) {
      if (ev.target.classList.contains("pin") || ev.target.closest(".tools")) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      el.setPointerCapture(ev.pointerId);
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        gesture = {
          mode: "pinch",
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          scale: scale,
          midX: (pts[0].x + pts[1].x) / 2,
          midY: (pts[0].y + pts[1].y) / 2
        };
      } else if (pointers.size === 1) {
        gesture = { mode: "pan", x: ev.clientX, y: ev.clientY, tx: tx, ty: ty, moved: false, t: Date.now() };
      }
    });
    el.addEventListener("pointermove", function (ev) {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2 && gesture && gesture.mode === "pinch") {
        ev.preventDefault();
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
        var midX = (pts[0].x + pts[1].x) / 2;
        var midY = (pts[0].y + pts[1].y) / 2;
        zoomAt(midX, midY, gesture.scale * (dist / gesture.dist));
        return;
      }
      if (gesture && gesture.mode === "pan" && pointers.size === 1) {
        var dx = ev.clientX - gesture.x;
        var dy = ev.clientY - gesture.y;
        if (Math.hypot(dx, dy) > 8) {
          gesture.moved = true;
          ev.preventDefault();
          tx = gesture.tx + dx;
          ty = gesture.ty + dy;
          apply();
        }
      }
    }, { passive: false });
    function endPointer(ev) {
      var was = gesture;
      pointers.delete(ev.pointerId);
      if (pointers.size === 0 && was && was.mode === "pan" && !was.moved && Date.now() - was.t < 600) {
        var p = clientToImage(ev.clientX, ev.clientY);
        if (p.x >= 0 && p.y >= 0 && p.x <= img.naturalWidth && p.y <= img.naturalHeight) tapFn(p.x, p.y);
      }
      if (pointers.size < 2) gesture = pointers.size === 1 ? null : null;
    }
    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);
    el.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

    var api = {
      fit: fit,
      zoomBy: function (factor) {
        var rect = el.getBoundingClientRect();
        zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, scale * factor);
      },
      onTap: function (fn) { tapFn = fn; },
      onMarkerDrag: function (fn) { dragFn = fn; },
      setMarkers: setMarkers,
      clientToImage: clientToImage,
      imageToClient: imageToClient
    };
    if (img.complete && img.naturalWidth) fit();
    else img.addEventListener("load", fit);
    window.addEventListener("resize", fit);
    return api;
  }
  root.createScanViewer = createViewer;
})(typeof self !== "undefined" ? self : this);
