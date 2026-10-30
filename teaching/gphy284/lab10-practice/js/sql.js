/* Small WHERE-clause parser for the contour exercise.
   Accepts comparisons, AND/OR/NOT, parentheses, and MOD(field, number).
   It never evaluates the text as code. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabSQL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  var FIELDS = { contour: "number", type: "string" };

  function tokenize(input) {
    var src = String(input || "");
    if (src.length > 180) throw new Error("That expression is too long.");
    var tokens = [];
    var i = 0;
    while (i < src.length) {
      var ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === "'" || ch === '"') {
        var quote = ch;
        var text = "";
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") throw new Error("Escape characters are not allowed.");
          text += src[i];
          i++;
        }
        if (src[i] !== quote) throw new Error("A text value is missing its closing quote.");
        i++;
        /* ArcGIS quotes field names with double quotes and text with single quotes. */
        if (quote === '"' && Object.prototype.hasOwnProperty.call(FIELDS, text.toLowerCase())) {
          tokens.push({ t: "word", v: text });
        } else {
          tokens.push({ t: "string", v: text });
        }
        continue;
      }
      var two = src.slice(i, i + 2);
      if (two === "<>" || two === "!=" || two === "<=" || two === ">=") {
        tokens.push({ t: "op", v: two === "!=" ? "<>" : two });
        i += 2;
        continue;
      }
      if ("(),=<>".indexOf(ch) >= 0) {
        tokens.push({ t: ch === "(" || ch === ")" ? ch : "op", v: ch });
        i++;
        continue;
      }
      if (/[0-9.]/.test(ch) || (ch === "-" && /[0-9.]/.test(src[i + 1] || ""))) {
        var num = ch;
        i++;
        while (i < src.length && /[0-9.]/.test(src[i])) { num += src[i]; i++; }
        if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(num)) throw new Error("'" + num + "' is not a number.");
        tokens.push({ t: "number", v: Number(num) });
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        var word = ch;
        i++;
        while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { word += src[i]; i++; }
        tokens.push({ t: "word", v: word });
        continue;
      }
      throw new Error("Unexpected character '" + ch + "'.");
    }
    return tokens;
  }

  function Parser(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }
  Parser.prototype.peek = function () { return this.tokens[this.i] || null; };
  Parser.prototype.take = function () { return this.tokens[this.i++] || null; };
  Parser.prototype.parse = function () {
    if (!this.tokens.length) throw new Error("Enter a WHERE clause.");
    var fn = this.orExpr();
    if (this.peek()) throw new Error("Could not read the rest of the expression.");
    return fn;
  };
  Parser.prototype.orExpr = function () {
    var left = this.andExpr();
    while (this.peek() && this.peek().t === "word" && this.peek().v.toUpperCase() === "OR") {
      this.take();
      var right = this.andExpr();
      var a = left;
      var b = right;
      left = function (row) { return a(row) || b(row); };
    }
    return left;
  };
  Parser.prototype.andExpr = function () {
    var left = this.notExpr();
    while (this.peek() && this.peek().t === "word" && this.peek().v.toUpperCase() === "AND") {
      this.take();
      var right = this.notExpr();
      var a = left;
      var b = right;
      left = function (row) { return a(row) && b(row); };
    }
    return left;
  };
  Parser.prototype.notExpr = function () {
    if (this.peek() && this.peek().t === "word" && this.peek().v.toUpperCase() === "NOT") {
      this.take();
      var inner = this.notExpr();
      return function (row) { return !inner(row); };
    }
    return this.primary();
  };
  Parser.prototype.primary = function () {
    var tok = this.peek();
    if (!tok) throw new Error("The expression ended early.");
    if (tok.t === "(") {
      this.take();
      var inner = this.orExpr();
      var close = this.take();
      if (!close || close.t !== ")") throw new Error("Missing a closing parenthesis.");
      return inner;
    }
    return this.comparison();
  };
  Parser.prototype.fieldName = function () {
    var tok = this.take();
    if (!tok) throw new Error("Expected a field name.");
    var name = tok.t === "word" ? tok.v : "";
    if (!name || !Object.prototype.hasOwnProperty.call(FIELDS, name.toLowerCase())) {
      throw new Error("Unknown field '" + (tok.v || "") + "'. Use Contour or Type.");
    }
    return name.toLowerCase();
  };
  Parser.prototype.valueExpr = function () {
    var tok = this.peek();
    if (!tok) throw new Error("Expected a value.");
    if (tok.t === "word" && tok.v.toUpperCase() === "MOD") {
      this.take();
      if (!this.take() || this.tokens[this.i - 1].t !== "(") throw new Error("MOD needs parentheses: MOD(Contour, 100).");
      var field = this.fieldName();
      if (FIELDS[field] !== "number") throw new Error("MOD only works on the Contour field.");
      var comma = this.take();
      if (!comma || comma.v !== ",") throw new Error("MOD needs two inputs: MOD(Contour, 100).");
      var divisorTok = this.take();
      if (!divisorTok || divisorTok.t !== "number") throw new Error("The second MOD input must be a number.");
      if (divisorTok.v === 0) throw new Error("MOD cannot divide by zero.");
      var end = this.take();
      if (!end || end.t !== ")") throw new Error("MOD is missing a closing parenthesis.");
      var divisor = divisorTok.v;
      return { kind: "mod", field: field, divisor: divisor };
    }
    if (tok.t === "word") return { kind: "field", field: this.fieldName() };
    this.take();
    if (tok.t === "number") return { kind: "number", value: tok.v };
    if (tok.t === "string") return { kind: "string", value: tok.v };
    throw new Error("Expected a field, a number, or quoted text.");
  };
  Parser.prototype.comparison = function () {
    var left = this.valueExpr();
    var opTok = this.take();
    if (!opTok || opTok.t !== "op") throw new Error("Expected a comparison such as =, <, or <>.");
    var right = this.valueExpr();
    var op = opTok.v;
    return function (row) {
      var a = evalValue(left, row);
      var b = evalValue(right, row);
      if (typeof a === "number" && typeof b === "number") {
        if (op === "=") return nearly(a, b);
        if (op === "<>") return !nearly(a, b);
        if (op === "<") return a < b && !nearly(a, b);
        if (op === ">") return a > b && !nearly(a, b);
        if (op === "<=") return a < b || nearly(a, b);
        if (op === ">=") return a > b || nearly(a, b);
      }
      var as = String(a).toLowerCase();
      var bs = String(b).toLowerCase();
      if (op === "=") return as === bs;
      if (op === "<>") return as !== bs;
      return false;
    };
  };

  function nearly(a, b) {
    return Math.abs(a - b) <= 1e-6;
  }

  function evalValue(node, row) {
    if (node.kind === "number" || node.kind === "string") return node.value;
    if (node.kind === "field") {
      if (node.field === "contour") return Number(row.Contour);
      return row.Type == null ? "" : String(row.Type);
    }
    var raw = Number(row.Contour);
    var m = raw % node.divisor;
    if (m < 0) m += Math.abs(node.divisor);
    /* Snap floating-point leftovers of integer elevations. */
    if (Math.abs(m) < 1e-6 || Math.abs(Math.abs(m) - Math.abs(node.divisor)) < 1e-6) return 0;
    return m;
  }

  function compile(text) {
    var parser = new Parser(tokenize(text));
    return parser.parse();
  }

  return { compile: compile };
});
