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
      reliability: ["high", "medium", "low"].indexOf(s.reliability) >= 0 ? s.reliability : "medium",
      // Конспект источника (гл. 4 Безруковой): понятия, положения, тезисы, факты,
      // гипотезы автора, выводы, цитаты, замечания + связи с задачами и параграфами.
      notes: {
        concepts: "", positions: "", theses: "", facts: "", authorHypotheses: "",
        conclusions: "", quotes: "", remarks: "", tasks: "", sections: ""
      }
    };
    m.sources.push(n);
    return n;
  }

  var NOTE_FIELDS = ["concepts", "positions", "theses", "facts", "authorHypotheses",
    "conclusions", "quotes", "remarks", "tasks", "sections"];

  function updateNotes(m, id, patch) {
    var s = m.sources.filter(function (x) { return x.id === id; })[0];
    if (!s) return null;
    if (!s.notes) s.notes = {};
    NOTE_FIELDS.forEach(function (k) {
      if (patch && typeof patch[k] === "string") s.notes[k] = patch[k];
    });
    return s;
  }

  function noteFilled(s) {
    if (!s.notes) return false;
    return NOTE_FIELDS.slice(0, 8).some(function (k) { return (s.notes[k] || "").trim().length > 0; });
  }

  function updateSource(m, id, patch) {
    var s = m.sources.filter(function (x) { return x.id === id; })[0];
    if (!s) return null;
    ["title", "author", "year", "type", "url", "doi", "reliability"].forEach(function (k) {
      if (patch && typeof patch[k] === "string") s[k] = patch[k].trim();
    });
    if (patch && patch.resolved !== undefined) s.resolved = !!patch.resolved;
    if (patch && patch.resolvedMeta) s.resolvedMeta = patch.resolvedMeta;
    return s;
  }

  // Нормализация записи Crossref → поля источника (для source resolver).
  function parseCrossrefItem(it) {
    if (!it) return null;
    var title = Array.isArray(it.title) ? it.title[0] : (it.title || "");
    var author = Array.isArray(it.author)
      ? it.author.map(function (a) { return [a.family, a.given].filter(Boolean).join(" "); }).filter(Boolean).join(", ")
      : "";
    var year = "";
    if (it.issued && it.issued["date-parts"] && it.issued["date-parts"][0]) {
      year = String(it.issued["date-parts"][0][0] || "");
    }
    var container = Array.isArray(it["container-title"]) ? (it["container-title"][0] || "") : "";
    return {
      title: String(title).trim(), author: author, year: year,
      doi: String(it.DOI || "").trim(), url: String(it.URL || "").trim(), container: container
    };
  }

  // Библиографическая строка по ГОСТ Р 7.0.5 (грубая, из полей источника).
  function gostLine(s) {
    var parts = [s.author, s.title];
    if (s.container) parts.push("// " + s.container);
    if (s.year) parts.push("— " + s.year + ".");
    var line = parts.filter(Boolean).join(" ");
    if (s.doi) line += " doi:" + s.doi;
    else if (s.url) line += " URL: " + s.url;
    return line.replace(/\s+/g, " ").trim();
  }

  function updateSelfReview(m, idx, done) {
    if (!m.selfReview) m.selfReview = { done: {}, note: "" };
    if (typeof idx === "number" && idx >= 0) m.selfReview.done[idx] = !!done;
    return m.selfReview;
  }

  function setSelfReviewNote(m, note) {
    if (!m.selfReview) m.selfReview = { done: {}, note: "" };
    m.selfReview.note = String(note || "");
    return m.selfReview;
  }

  function selfReviewStats(m, total) {
    var sr = m.selfReview || { done: {}, note: "" };
    var done = 0;
    for (var i = 0; i < (total || 0); i++) if (sr.done[i]) done++;
    return { done: done, total: total || 0, note: sr.note };
  }

  // Прогноз → результат (по Безруковой: новизна/значимость прогнозируются на старте
  // и сопоставляются с фактическими результатами после исследования).
  function updateOutcome(m, patch) {
    if (!m.outcome) m.outcome = { noveltyActual: "", significanceActual: "", comparison: "" };
    ["noveltyActual", "significanceActual", "comparison"].forEach(function (k) {
      if (patch && typeof patch[k] === "string") m.outcome[k] = patch[k];
    });
    return m.outcome;
  }

  function outcomeReady(m) {
    return !!(m.outcome && (m.outcome.noveltyActual.trim() || m.outcome.significanceActual.trim()));
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
    a.sourcesWithNotes = m.sources.filter(noteFilled).length;
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
    if (ctx.contradictionReady != null) items.push({ name: "Противоречие из материала (разрыв и звенья)", done: !!ctx.contradictionReady });
    items.push({ name: "Новизна: прогноз с основанием", done: !!ctx.noveltyReady });
    items.push({ name: "Вопросы исследования уточнены", done: !!ctx.questionsReady });
    items.push({ name: "Источников ≥ 3", done: m.sources.length >= 3 });
    items.push({ name: "Конспект ≥ 2 источников", done: m.sources.filter(noteFilled).length >= 2 });
    items.push({ name: "Утверждений ≥ 3", done: m.claims.length >= 3 });
    var aud = audit(m);
    items.push({ name: "≥ 50% утверждений с источником", done: aud.total > 0 && aud.coverage >= 50 });
    if (ctx.selfReviewTotal) {
      var sr = selfReviewStats(m, ctx.selfReviewTotal);
      items.push({ name: "Самоэкспертиза: критерии пройдены", done: sr.done >= sr.total });
    }
    if (ctx.outcomeExpected) items.push({ name: "Фактическая новизна/значимость зафиксированы", done: outcomeReady(m) });
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
    if (!m.claims.length && !m.sources.length && !m.selfReview && !m.outcome) return "";
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

    var noted = m.sources.filter(noteFilled);
    if (noted.length) {
      L.push("");
      L.push("## Конспекты источников (гл. 4 Безруковой)");
      noted.forEach(function (s) {
        L.push("");
        L.push("### " + s.id + ". " + s.title);
        var labels = { concepts: "Основные понятия", positions: "Основные положения", theses: "Тезисы",
          facts: "Факты", authorHypotheses: "Гипотезы автора", conclusions: "Выводы",
          quotes: "Цитаты", remarks: "Мои замечания", tasks: "Связь с задачами", sections: "Связь с параграфами" };
        NOTE_FIELDS.forEach(function (k) {
          if ((s.notes[k] || "").trim()) L.push("- **" + labels[k] + ":** " + s.notes[k]);
        });
      });
    }

    if (m.selfReview && (Object.keys(m.selfReview.done).length || m.selfReview.note)) {
      L.push("");
      L.push("## Самоэкспертиза (гл. 10 Безруковой)");
      Object.keys(m.selfReview.done).forEach(function (i) {
        L.push("- " + (m.selfReview.done[i] ? "✅" : "⬜") + " критерий №" + (Number(i) + 1));
      });
      if (m.selfReview.note) L.push("- Заметки: " + m.selfReview.note);
    }

    if (m.outcome && (m.outcome.noveltyActual || m.outcome.significanceActual || m.outcome.comparison)) {
      L.push("");
      L.push("## Новизна и значимость: прогноз → результат");
      if (m.outcome.noveltyActual) L.push("- **Фактическая новизна:** " + m.outcome.noveltyActual);
      if (m.outcome.significanceActual) L.push("- **Фактическая значимость:** " + m.outcome.significanceActual);
      if (m.outcome.comparison) L.push("- **Сопоставление с прогнозом:** " + m.outcome.comparison);
    }
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
    CLAIM_TYPES: CLAIM_TYPES, STATUSES: STATUSES, NOTE_FIELDS: NOTE_FIELDS,
    emptyModel: emptyModel, clone: clone,
    addClaim: addClaim, updateClaim: updateClaim, removeClaim: removeClaim,
    addSource: addSource, removeSource: removeSource, link: link,
    updateNotes: updateNotes, noteFilled: noteFilled, updateSource: updateSource,
    parseCrossrefItem: parseCrossrefItem, gostLine: gostLine,
    updateSelfReview: updateSelfReview, setSelfReviewNote: setSelfReviewNote, selfReviewStats: selfReviewStats,
    updateOutcome: updateOutcome, outcomeReady: outcomeReady,
    audit: audit, completeness: completeness, sourceResolved: sourceResolved,
    toMarkdown: toMarkdown, serialize: serialize, deserialize: deserialize
  };
});
