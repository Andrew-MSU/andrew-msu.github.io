(function () {
  var problems = [
    { id: "a-lat", label: "Corner A latitude", dms: "45° 32′ 16″ N", value: 45 + 32 / 60 + 16 / 3600, negative: false },
    { id: "a-lon", label: "Corner A longitude", dms: "112° 36′ 48″ W", value: -(112 + 36 / 60 + 48 / 3600), negative: true },
    { id: "b-lat", label: "Corner B latitude", dms: "45° 33′ 51″ N", value: 45 + 33 / 60 + 51 / 3600, negative: false },
    { id: "b-lon", label: "Corner B longitude", dms: "112° 34′ 05″ W", value: -(112 + 34 / 60 + 5 / 3600), negative: true },
    { id: "c-lat", label: "Corner C latitude", dms: "45° 29′ 27″ N", value: 45 + 29 / 60 + 27 / 3600, negative: false },
    { id: "c-lon", label: "Corner C longitude", dms: "112° 39′ 14″ W", value: -(112 + 39 / 60 + 14 / 3600), negative: true },
    { id: "d-lat", label: "Corner D latitude", dms: "45° 35′ 08″ N", value: 45 + 35 / 60 + 8 / 3600, negative: false },
    { id: "d-lon", label: "Corner D longitude", dms: "112° 33′ 22″ W", value: -(112 + 33 / 60 + 22 / 3600), negative: true }
  ];
  var TOL = 0.00006;
  var host = document.getElementById("problems");
  var summary = document.getElementById("feedback");

  problems.forEach(function (p) {
    var block = document.createElement("div");
    block.className = "problem";
    block.innerHTML =
      "<h3>" + p.label + "</h3>" +
      "<p class=\"hint\">" + p.dms + "</p>" +
      "<div class=\"row\">" +
      "<label class=\"field\" style=\"flex:1\">Decimal degrees" +
      "<input id=\"" + p.id + "\" inputmode=\"decimal\" autocomplete=\"off\" aria-describedby=\"" + p.id + "-msg\">" +
      "</label>" +
      "<button type=\"button\" class=\"secondary\" id=\"" + p.id + "-sign\">±</button>" +
      "</div>" +
      "<p id=\"" + p.id + "-msg\" class=\"hint\" role=\"status\"></p>";
    host.appendChild(block);
    var input = block.querySelector("input");
    var msg = block.querySelector("p[role=status]");
    block.querySelector("button").setAttribute("aria-label", "Toggle the sign of " + p.label);
    block.querySelector("button").addEventListener("click", function () {
      var n = Number(input.value);
      if (!input.value.trim()) { input.value = "-"; input.focus(); return; }
      if (Number.isFinite(n)) input.value = String(-n);
      judge(p, input, msg);
    });
    input.addEventListener("input", function () { judge(p, input, msg); });
  });

  function judge(p, input, msg) {
    msg.className = "hint";
    if (!input.value.trim() || input.value.trim() === "-" || input.value.trim() === ".") {
      msg.textContent = "";
      return false;
    }
    var n = Number(input.value);
    if (!Number.isFinite(n)) {
      msg.textContent = "Enter a decimal number.";
      msg.className = "hint flag bad";
      return false;
    }
    if (Math.abs(Math.abs(n) - Math.abs(p.value)) <= TOL && Math.sign(n) !== Math.sign(p.value)) {
      msg.textContent = p.negative
        ? "The size is right. West longitude is negative — add a minus sign."
        : "The size is right, but the sign is not.";
      msg.className = "hint flag bad";
      return false;
    }
    if (Math.abs(n - p.value) <= TOL) {
      msg.textContent = "Correct.";
      msg.className = "hint flag ok";
      return true;
    }
    msg.textContent = "Not yet. decimal = degrees + minutes/60 + seconds/3600.";
    msg.className = "hint flag bad";
    return false;
  }

  document.getElementById("check").addEventListener("click", function () {
    var correct = 0;
    problems.forEach(function (p) {
      var input = document.getElementById(p.id);
      var msg = document.getElementById(p.id + "-msg");
      if (judge(p, input, msg)) correct++;
    });
    summary.className = "feedback " + (correct === problems.length ? "ok" : "bad");
    summary.textContent = correct + " of " + problems.length + " correct.";
    if (correct === problems.length) {
      summary.textContent += " West is negative, and each value is degrees plus minutes/60 plus seconds/3600.";
      LabStore.mark("dms");
    }
  });

  document.getElementById("reset").addEventListener("click", function () {
    problems.forEach(function (p) {
      document.getElementById(p.id).value = "";
      var msg = document.getElementById(p.id + "-msg");
      msg.textContent = "";
      msg.className = "hint";
    });
    summary.className = "feedback";
    summary.textContent = "Cleared.";
  });
})();
