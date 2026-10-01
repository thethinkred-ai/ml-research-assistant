/* research-model.js — модель исследовательской логики: реестр утверждений (claims),
   источников (sources) и связей между ними + локальный «научный линтер» (audit).
   Рецензионное ядро V1.2: каждое существенное утверждение получает ID, тип и статус
   доказательности; текст ссылается на ID; аудит показывает покрытие утверждений
   источниками. Чистые функции, без DOM, без сети. */
(function (global, factory) {
  var api = factory(global);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.MLModel = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function (global) {
  "use strict";

  // Типы утверждений — три разных уровня доказательства (см. рецензию, п. 5).
  var CLAIM_TYPES = {
    definition:   { label: "определение",     hint: "введение/уточнение понятия" },
    textual:      { label: "текстовое",        hint: "что именно утверждает автор в источнике" },
    historical:   { label: "историческое",     hint: "факт прошлого: дата, событие, последовательность" },
    empirical:    { label: "эмпирическое",     hint: "наблюдаемый факт без количественной меры" },
    quantitative: { label: "количественное",   hint: "число, доля, динамика — требует данных" },
    causal:       { label: "причинное",        hint: "X является причиной Y — требует механизма и данных" },
    theoretical:  { label: "теоретическое",    hint: "закономерность/интерпретация в рамках теории" },
    normative:    { label: "нормативное",      hint: "оценка/долженствование — требует явной посылки" }
  };

  // Статусы доказательности.
  var STATUSES = {
    unverified:     { label: "требует источника",     ok: false },
    needsArgument:  { label: "требует аргумента",     ok: false },
    disputed:       { label: "спорно",                ok: false },
    partial:        { label: "частично подтверждено", ok: true },
    supported:      { label: "подтверждено",          ok: true }
  };

  function emptyModel() {
    return {
      claims: [],        // {id, text, type, status, sourceIds:[], evidence, note}
      sources: [],       // {id, title, author, year, type, url, doi, reliability}
      seq: { claim: 0, source: 0 }
    };
  }

  function clone(m) { return JSON.parse(JSON.stringify(m || emptyModel())); }

  function normClaim(c) {
    return {
      text: String(c.text || "").trim(),
      type: CLAIM_TYPES[c.type] ? c.type : "theoretical",
      status: STATUSES[c.status] ? c.status : "unverified",
      sourceIds: Array.isArray(c.sourceIds) ? c.sourceIds.filter(function (id) { return typeof id === "string"; }) : [],
      evidence: String(c.evidence || "").trim(),
      note: String(c.note || "").trim()
    };
  }

  function addClaim(m, c) {
    var n = normClaim(c);
    if (!n.text) return null;
    m.seq.claim++;
    n.id = "CLM-" + String(m.seq.claim).padStart(3, "0");
    m.claims.push(n);
    return n;
  }

  function updateClaim(m, id, patch) {
    var c = m.claims.filter(function (x) { return x.id === id; })[0];
    if (!c) return null;
    var merged = normClaim(Object.assign({}, c, patch));
    merged.id = id;
    m.claims.splice(m.claims.indexOf(c), 1, merged);
    return merged;
  }

  function removeClaim(m, id) {
    m.claims = m.claims.filter(function (x) { return x.id !== id; });
  }

  function addSource(m, s) {
    var title = String(s.title || "").trim();
    if (!title) return null;
    m.seq.source++;
    var n = {
      id: "SRC-" + String(m.seq.source).padStart(3, "0"),
      title: title,
      author: String(s.author || "").trim(),
      year: String(s.year || "").trim(),
      type: String(s.type || "paper").trim(),
      url: String(s.url || "").trim(),
      doi: String(s.doi || "").trim(),
      reliability: ["high", "medium", "low"].indexOf(s.reliability) >= 0 ? s.reliability : "medium"
    };
    m.sources.push(n);
    return n;
  }

  function removeSource(m, id) {
    m.sources = m.sources.filter(function (x) { return x.id !== id; });
    m.claims.forEach(function (c) { c.sourceIds = c.sourceIds.filter(function (s) { return s !== id; }); });
  }

  function link(m, claimId, sourceId) {
    var c = m.claims.filter(function (x) { return x.id === claimId; })[0];
    if (!c) return false;
    if (!m.sources.some(function (s) { return s.id === sourceId; })) return false;
    if (c.sourceIds.indexOf(sourceId) < 0) c.sourceIds.push(sourceId);
    return true;
  }

  // Источник считается проверенным, когда у него есть DOI или URL (минимальная
  // резолвимость; полный resolver — этап V1.3+).
  function sourceResolved(s) { return !!(s.doi || s.url); }

  // «Научный линтер»: покрытие утверждений источниками по типам + готовность работы.
  function audit(m) {
    var a = {
      total: m.claims.length,
      withSource: 0, withoutSource: 0,
      byType: {}, unbackedCausal: [], unbackedQuant: [], unbackedHistorical: [],
      disputed: [], unresolvedSources: [],
      sources: m.sources.length, sourcesResolved: 0,
      coverage: null
    };
    Object.keys(CLAIM_TYPES).forEach(function (t) { a.byType[t] = { total: 0, backed: 0 }; });
    m.sources.forEach(function (s) { if (sourceResolved(s)) a.sourcesResolved++; else a.unresolvedSources.push(s); });
    m.claims.forEach(function (c) {
      var backed = c.sourceIds.length > 0 || (c.status !== "unverified" && !!c.evidence);
      if (backed) a.withSource++; else a.withoutSource++;
      if (!a.byType[c.type]) a.byType[c.type] = { total: 0, backed: 0 };
      a.byType[c.type].total++;
      if (backed) a.byType[c.type].backed++;
      if (!backed) {
        if (c.type === "causal") a.unbackedCausal.push(c);
        if (c.type === "quantitative") a.unbackedQuant.push(c);
        if (c.type === "historical") a.unbackedHistorical.push(c);
        if (c.status === "disputed") a.disputed.push(c);
      }
    });
    a.coverage = a.total ? Math.round((a.withSource / a.total) * 100) : null;
    return a;
  }

  // Research completeness: доля реально выполненных элементов исследования
  // (не декоративный процент — считаем по фактам, см. рецензию п. 16).
  function completeness(m, ctx) {
    ctx = ctx || {};
    var items = [];
    items.push({ name: "Тема и аппарат исследования", done: !!ctx.topicReady });
    if (ctx.hasEmpirical) items.push({ name: "Гипотеза собрана (без плейсхолдеров)", done: !!ctx.hypothesisReady });
    items.push({ name: "Новизна: указано основание", done: !!ctx.noveltyReady });
    items.push({ name: "Вопросы исследования уточнены", done: !!ctx.questionsReady });
    items.push({ name: "Источников ≥ 3", done: m.sources.length >= 3 });
    items.push({ name: "Утверждений ≥ 3", done: m.claims.length >= 3 });
    var aud = audit(m);
    items.push({ name: "≥ 50% утверждений с источником", done: aud.total > 0 && aud.coverage >= 50 });
    if (ctx.draftRatio != null) items.push({ name: "Черновик развёрнут", done: ctx.draftRatio >= 0.5 });
    var done = items.filter(function (i) { return i.done; }).length;
    return { percent: Math.round((done / items.length) * 100), items: items };
  }

  function sourceLine(s) {
    var bits = [s.author, s.title, s.year ? "(" + s.year + ")" : ""].filter(Boolean).join(" ");
    var id = s.doi ? "doi:" + s.doi : (s.url || "");
    return bits + (id ? " — " + id : "") + " · надёжность: " + s.reliability +
      (sourceResolved(s) ? "" : " · [не резолвится — проверить существование]");
  }

  // Реестр в Markdown — для экспорта и research-брифа.
  function toMarkdown(m) {
    if (!m.claims.length && !m.sources.length) return "";
    var L = [];
    L.push("## Реестр утверждений (Claim Ledger)");
    L.push("");
    if (!m.claims.length) {
      L.push("_(утверждений не зафиксировано)_");
    } else {
      L.push("| ID | Утверждение | Тип | Статус | Источники |");
      L.push("|---|---|---|---|---|");
      m.claims.forEach(function (c) {
        L.push("| " + c.id + " | " + c.text.replace(/\|/g, "\\|") + " | " + CLAIM_TYPES[c.type].label +
          " | " + STATUSES[c.status].label + " | " + (c.sourceIds.join(", ") || "—") + " |");
      });
      var withEv = m.claims.filter(function (c) { return c.evidence; });
      if (withEv.length) {
        L.push("");
        withEv.forEach(function (c) {
          L.push("**" + c.id + "** — доказательство: " + c.evidence +
            (c.note ? " _(" + c.note + ")_" : ""));
        });
      }
    }
    L.push("");
    L.push("## Источники (Source Manager)");
    L.push("");
    if (!m.sources.length) {
      L.push("_(источники не зафиксированы)_");
    } else {
      m.sources.forEach(function (s, i) { L.push((i + 1) + ". **" + s.id + "**. " + sourceLine(s)); });
    }
    L.push("");
    L.push("> Правило: `[источник]` — временный статус. Источник допускается в текст, когда его " +
      "существование резолвится (DOI/URL), а утверждение связано с ним в реестре.");
    return L.join("\n");
  }

  function serialize(m) { return JSON.stringify(m); }
  function deserialize(s) {
    try {
      var m = JSON.parse(s);
      if (!m || !Array.isArray(m.claims) || !Array.isArray(m.sources)) return emptyModel();
      return m;
    } catch (e) { return emptyModel(); }
  }

  return {
    CLAIM_TYPES: CLAIM_TYPES, STATUSES: STATUSES,
    emptyModel: emptyModel, clone: clone,
    addClaim: addClaim, updateClaim: updateClaim, removeClaim: removeClaim,
    addSource: addSource, removeSource: removeSource, link: link,
    audit: audit, completeness: completeness, sourceResolved: sourceResolved,
    toMarkdown: toMarkdown, serialize: serialize, deserialize: deserialize
  };
});
