(function () {
  var done = window.LabStore ? LabStore.all() : {};
  document.querySelectorAll("[data-done]").forEach(function (el) {
    if (done[el.getAttribute("data-done")]) {
      var mark = document.createElement("span");
      mark.className = "flag ok";
      mark.textContent = " Checked";
      el.appendChild(mark);
    }
  });
})();
