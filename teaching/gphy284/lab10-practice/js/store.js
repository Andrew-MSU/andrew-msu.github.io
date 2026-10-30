(function (root) {
  var KEY = "gphy284-lab10-practice";
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); }
    catch (e) { return {}; }
  }
  root.LabStore = {
    all: read,
    mark: function (id) {
      var data = read();
      data[id] = true;
      localStorage.setItem(KEY, JSON.stringify(data));
    }
  };
})(typeof self !== "undefined" ? self : this);
