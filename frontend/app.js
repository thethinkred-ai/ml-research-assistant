/* app.js — логика интерфейса: форма → каркас → вкладки «Каркас»/«Черновик»,
   редактируемые секции, экспорт (.md/.doc/.html/копирование/печать), шаринг ссылки,
   LLM-развёртывание со статусом, отменой и дозапуском упавших секций. */
(function () {
  "use strict";
  var E = window.MLResearchEngine, P = window.MLPrompts, L = window.MLLlm, X = window.MLExport, R = window.MLResearch;

  var state = {
    bp: null,        // текущий каркас
    md: null,        // markdown каркаса (редактируемый)
    sections: null,  // результаты LLM по секциям (редактируемые)
    tasks: null,     // список задач развёртывания
    words: 300,      // бюджет слов на секцию
    errors: [],      // ошибки последнего прогона
    tab: "bp",
    cfg: null,       // настройки модели
    ctrl: null,      // AbortController текущего прогона
    title: null      // данные титульного листа
  };

  function $(id) { return document.getElementById(id); }
  function val(id) { return $(id).value; }
  function chk(id) { return $(id).checked; }
  function esc(s) { return X.esc(s); }

  // ---------- форма ----------

  var FORM_IDS = ["topic", "kind", "vol", "field", "depth", "extra", "sources", "emp", "app"];

  function collect() {
    return {
      topic: val("topic"), kind: val("kind"), field: val("field"),
      hasEmpirical: chk("emp"), applied: chk("app"),
      volumePages: val("vol"), extraKeywords: val("extra"), sources: val("sources")
    };
  }

  function saveForm() {
    try {
      var f = {};
      FORM_IDS.forEach(function (id) {
        var el = $(id);
        f[id] = el.type === "checkbox" ? el.checked : el.value;
      });
      localStorage.setItem("ml_form", JSON.stringify(f));
    } catch (e) { /* приватный режим и т.п. */ }
  }

  function restoreForm() {
    try {
      var f = JSON.parse(localStorage.getItem("ml_form") || "{}");
      FORM_IDS.forEach(function (id) {
        if (!(id in f)) return;
        var el = $(id);
        if (el.type === "checkbox") el.checked = !!f[id]; else el.value = f[id];
      });
    } catch (e) { /* ignore */ }
  }

  function buildShareUrl() {
    var p = new URLSearchParams();
    p.set("topic", val("topic"));
    if (val("kind")) p.set("kind", val("kind"));
    if (val("field")) p.set("field", val("field"));
    if (val("vol")) p.set("vol", val("vol"));
    if (val("extra")) p.set("extra", val("extra"));
    if (val("sources")) p.set("sources", val("sources"));
    p.set("emp", chk("emp") ? "1" : "0");
    p.set("app", chk("app") ? "1" : "0");
    return location.href.split("?")[0] + "?" + p.toString();
  }

  // ---------- титульный лист ----------

  var TP_IDS = ["tp_org", "tp_chair", "tp_author", "tp_advisor", "tp_city", "tp_year"];

  function defaultTitle() {
    return {
      org: "[Наименование учебного заведения]", chair: "[Кафедра]",
      author: "[ФИО автора, группа]", advisor: "[должность, ФИО руководителя]",
      city: "[Город]", year: String(new Date().getFullYear())
    };
  }
  function loadTitle() {
    try { return Object.assign(defaultTitle(), JSON.parse(localStorage.getItem("ml_title") || "{}")); }
    catch (e) { return defaultTitle(); }
  }
  function saveTitle() {
    try { localStorage.setItem("ml_title", JSON.stringify(state.title)); } catch (e) { /* ignore */ }
  }

  function tpData() {
    return {
      org: state.title.org, chair: state.title.chair,
      author: state.title.author, advisor: state.title.advisor,
      city: state.title.city, year: state.title.year,
      kindLabel: state.bp ? state.bp.kindLabel : "",
      topic: state.bp ? state.bp.meta.topic : ""
    };
  }

  function renderTitlePage() {
    var box = $("titlepage");
    if (!box.innerHTML.trim()) {
      box.innerHTML =
        '<details open class="titlepage-box"><summary>Титульный лист — заполните поля (попадает в экспорт и печать)</summary>' +
        '<div class="tp-form">' +
        '<div class="row"><input id="tp_org" type="text" placeholder="Учебное заведение"><input id="tp_chair" type="text" placeholder="Кафедра"></div>' +
        '<div class="row"><input id="tp_author" type="text" placeholder="Выполнил(а): ФИО, группа"><input id="tp_advisor" type="text" placeholder="Руководитель: должность, ФИО"></div>' +
        '<div class="row"><input id="tp_city" type="text" placeholder="Город"><input id="tp_year" type="text" placeholder="Год"></div>' +
        '</div><div class="tp-preview" id="tp-preview"></div></details>';
      TP_IDS.forEach(function (id) { $(id).addEventListener("input", function () { syncTitle(); }); });
    }
    TP_IDS.forEach(function (id) {
      var key = id.slice(3, 4).toLowerCase() + id.slice(4);
      if ($(id).value !== state.title[key]) $(id).value = state.title[key];
    });
    updateTitlePreview();
  }
  function syncTitle() {
    TP_IDS.forEach(function (id) {
      var key = id.slice(3, 4).toLowerCase() + id.slice(4);
      state.title[key] = $(id).value;
    });
    saveTitle();
    updateTitlePreview();
  }
  function updateTitlePreview() {
    var pv = $("tp-preview");
    if (pv) pv.innerHTML = X.buildTitlePageHtml(tpData());
  }

  function titleMdText() {
    var d = tpData();
    return "ТИТУЛЬНЫЙ ЛИСТ (шаблон — заполните)\n\n" + d.org + "\n" + d.chair + "\n\n" +
      d.kindLabel.toUpperCase() + "\nна тему: «" + d.topic + "»\n\n" +
      "Выполнил(а): " + d.author + "\nРуководитель: " + d.advisor + "\n\n" + d.city + ", " + d.year +
      "\n\n---\n\n";
  }

  // ---------- генерация каркаса ----------

  function generate() {
    var bp = E.buildBlueprint(collect());
    state.bp = bp;
    state.md = E.toMarkdown(bp);
    state.sections = null; state.tasks = null; state.errors = [];
    updateDraftTab();
    renderTitlePage();
    renderBlueprint();
    setActiveTab("bp");
    saveForm();
  }

  // ---------- Отсылки к книге В. С. Безруковой (полный текст: /library/bezrukova.html) ----------
  var BOOK = "https://thinkred.ru/library/bezrukova.html";
  var BOOK_DIR = "https://thinkred.ru/library/";
  var BOOK_TIPS = [
    ["Актуальность",          "как строить актуальность, противоречие и проблему", "b04-glava-3.html#3-1-введение-к-исследованию"],
    ["Объект и предмет",      "чем объект отличается от предмета — формулировки",  "b12-slovar.html"],
    ["Цель и задачи",         "цель, задачи, гипотеза: требования и типовые ошибки", "b04-glava-3.html#3-1-введение-к-исследованию"],
    ["Гипотеза",              "как формулировать проверяемую гипотезу",            "b04-glava-3.html#3-1-введение-к-исследованию"],
    ["Методы",                "теоретические и эмпирические методы: полный арсенал", "b03-glava-2.html#2-3-проектирование-тактики-исследования"],
    ["Этапы",                 "стратегия и этапы исследования",                    "b03-glava-2.html#2-2-проектирование-стратегии-исследования"],
    ["Структура (план)",      "основная часть: как членить главы и параграфы",     "b04-glava-3.html#3-2-основная-часть-исследования"],
    ["Шаблон введения",       "образцы введений и типовые ошибки",                 "b04-glava-3.html#3-1-введение-к-исследованию"],
    ["Стартовый список литературы", "информационное обеспечение и конспектирование источников", "b05-glava-4.html#4-1-информационное-обеспечение-исследования"]
];
  function bookTip(title) {
    for (var i = 0; i < BOOK_TIPS.length; i++) {
      if (BOOK_TIPS[i][0] === title) {
        return '<div class="bookref">📖 Безрукова, гл. «' + esc(BOOK_TIPS[i][1]) + '» — <a href="' + BOOK_DIR + BOOK_TIPS[i][2] + '" target="_blank" rel="noopener">читать в библиотеке →</a></div>';
      }
    }
    return "";
  }

  function renderBlueprint() {
    var bp = state.bp, m = bp.meta, h = "";
    if (bp.topicCheck && bp.topicCheck.verdict !== "ok" && bp.topicCheck.verdict !== "empty") {
      var label = bp.topicCheck.verdict === "wide" ? "тема слишком широкая" : "тема перегружена";
      h += '<div class="warnbanner"><b>Проверка темы: ' + label + '.</b> ' + esc(bp.topicCheck.message) +
        '<br>Рекомендации: ' + esc(bp.topicCheck.suggestions.join(" ")) + '</div>';
    }
    h += '<h2 class="sec">Тема · ' + esc(bp.kindLabel) + '</h2>';
    h += '<div class="kv"><p><b>' + esc(m.topic) + '</b></p><p class="muted">Область: ' + esc(m.field) + ' · Объём: ~' + esc(String(m.volumePages)) + ' с. · Пресет дисциплины: ' + esc(bp.preset) + '</p></div>';
    h += bookTip("Актуальность");
    h += '<h2 class="sec">Актуальность</h2><div class="kv"><p>' + esc(bp.actualnost) + '</p><p><b>Противоречие.</b> ' + esc(bp.contradiction) + '</p><p><b>Проблема.</b> ' + esc(bp.problem) + '</p></div>';
    h += bookTip("Объект и предмет");
    h += '<h2 class="sec">Объект и предмет</h2><div class="kv"><p><b>Объект:</b> ' + esc(bp.object) + '</p><p><b>Предмет:</b> ' + esc(bp.subject) + '</p></div>';
    h += bookTip("Цель и задачи");
    h += '<h2 class="sec">Цель и задачи</h2><div class="kv"><p><b>Цель:</b> ' + esc(bp.goal) + '.</p><p><b>Задачи:</b></p><ol>' + bp.tasks.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
    if (bp.hypothesis) { h += bookTip("Гипотеза");
    h += '<h2 class="sec">Гипотеза</h2><div class="kv"><p>' + esc(bp.hypothesis) + '</p></div>'; }
    h += bookTip("Методы");
    h += '<h2 class="sec">Методы</h2><div class="kv"><p><b>Теоретические:</b> ' + esc(bp.methods.theoretical.join('; ')) + '</p><p><b>Эмпирические:</b> ' + esc(bp.methods.empirical.join('; ')) + '</p></div>';
    h += bookTip("Этапы");
    h += '<h2 class="sec">Этапы</h2><ol>' + bp.stages.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    h += '<div class="kv"><p><b>Научная новизна:</b> ' + esc(bp.novelty) + '.</p><p><b>Практическая значимость:</b> ' + esc(bp.significance) + '.</p></div>';
    h += bookTip("Структура (план)");
    h += '<h2 class="sec">Структура (план)</h2><div class="kv"><p>' + esc(bp.structure.front) + '</p>';
    bp.structure.chapters.forEach(function (c) { h += '<p><b>' + esc(c.title) + '</b></p><ul>' + c.sub.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'; });
    h += '<p>' + esc(bp.structure.back.join(' · ')) + '</p></div>';
    h += bookTip("Шаблон введения");
    h += '<h2 class="sec">Шаблон введения</h2><pre class="md">' + esc(bp.intro) + '</pre>';
    h += bookTip("Стартовый список литературы");
    h += '<h2 class="sec">Стартовый список литературы</h2><ol>' + bp.literature.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol>';
    h += '<p class="srclinks">Подобрать реальные источники: ' +
      bp.literatureLinks.map(function (l) { return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'; }).join('') + '</p>';
    h += '<details><summary>Исходник Markdown (можно редактировать — правки попадают в экспорт)</summary>' +
      '<textarea id="mdsrc" class="mdsrc" spellcheck="false">' + esc(state.md) + '</textarea>' +
      '<p class="muted">Красивый вид выше не пересчитывается — при правках исходника ориентируйтесь на текст в поле.</p></details>';
    h += renderOrxBlock(bp);
    h += '<details class="glossary"><summary>Словарь начинающего исследователя (подсказки по методике)</summary>' +
      '<dl>' + E.GLOSSARY.map(function (g) {
        return '<dt>' + esc(g.term) + '</dt><dd>' + esc(g.def) + '</dd>';
      }).join('') + '</dl></details>';
    $("pane-bp").innerHTML = h;
    $("mdsrc").addEventListener("input", function () { state.md = this.value; });
    $("dl-orx").addEventListener("click", function () {
      download(safeFile(bp) + "_RESEARCH_BRIEF.md", R.buildResearchBrief(bp), "text/markdown;charset=utf-8");
    });
  }

  // Блок интеграции с OpenResearch (alphaXiv): превью и скачивание брифа для агента.
  function renderOrxBlock(bp) {
    var brief = R.buildResearchBrief(bp);
    var preview = brief.split("\n").slice(0, 14).join("\n") + "\n…";
    return '<details class="orxblock"><summary>Интеграция с OpenResearch (alphaXiv) — задание для исследовательского агента</summary>' +
      '<p class="muted">OpenResearch — local-first воркспейс (CLI <code>orx</code>), превращающий кодинг-агентов в исследовательских: ' +
      'поиск литературы (<code>orx discover</code>/<code>orx paper</code>), git-нативное дерево экспериментов. Публичного HTTP API нет, ' +
      'поэтому интеграция — само-достаточный бриф: сохраните его как <code>RESEARCH_BRIEF.md</code> в корне проекта OpenResearch и дайте агенту. ' +
      'Установка: <code>curl -LsSf https://openresearch.sh/install.sh | sh</code>, затем <code>orx up</code>.</p>' +
      '<pre class="md">' + esc(preview) + '</pre>' +
      '<div class="btns"><button class="ghost" id="dl-orx" style="flex:none">Скачать бриф RESEARCH_BRIEF.md</button></div></details>';
  }

  // ---------- вкладки ----------

  function setActiveTab(tab) {
    state.tab = tab;
    $("tab-bp").classList.toggle("active", tab === "bp");
    $("tab-draft").classList.toggle("active", tab === "draft");
    $("pane-bp").classList.toggle("active", tab === "bp");
    $("pane-draft").classList.toggle("active", tab === "draft");
  }

  function updateDraftTab() {
    var has = !!state.sections;
    $("tab-draft").disabled = !has;
    if (!has) setActiveTab("bp");
  }

  // ---------- экспорт ----------

  function currentArtifact() {
    var tp = { titlePage: X.buildTitlePageHtml(tpData()) };
    if (state.tab === "draft" && state.sections) {
      var md = L.assembleMarkdown(state.bp, state.sections);
      return { title: state.bp.meta.topic, file: safeFile(state.bp) + "_черновик", md: titleMdText() + md, opts: tp };
    }
    return { title: state.bp.meta.topic, file: safeFile(state.bp), md: titleMdText() + state.md, opts: tp };
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function safeFile(bp) { return (bp.meta.topic || "karkas").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60); }

  function needArtifact() {
    if (!state.bp) generate();
    return currentArtifact();
  }

  $("dl-md").addEventListener("click", function () {
    var a = needArtifact();
    download(a.file + ".md", a.md, "text/markdown;charset=utf-8");
  });
  $("dl-doc").addEventListener("click", function () {
    var a = needArtifact();
    download(a.file + ".doc", X.buildWordHtml(a.title, a.md, a.opts), "application/msword;charset=utf-8");
  });
  $("dl-html").addEventListener("click", function () {
    var a = needArtifact();
    download(a.file + ".html", X.buildStandaloneHtml(a.title + " — каркас (" + state.bp.kindLabel + ")", a.md, a.opts), "text/html;charset=utf-8");
  });
  $("copy").addEventListener("click", function () {
    var a = needArtifact();
    navigator.clipboard.writeText(a.md).then(function () { flashButton($("copy"), "Скопировано"); });
  });
  $("print").addEventListener("click", function () { if (!state.bp) generate(); window.print(); });
  $("share").addEventListener("click", function () {
    var url = buildShareUrl();
    navigator.clipboard.writeText(url).then(
      function () { flashButton($("share"), "Ссылка скопирована"); },
      function () { window.prompt("Скопируйте ссылку:", url); }
    );
  });

  function flashButton(btn, text) {
    var old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1800);
  }

  // ---------- настройки модели ----------

  function loadCfg() { try { return JSON.parse(localStorage.getItem("ml_cfg") || "{}"); } catch (e) { return {}; } }
  function saveCfg(c) { try { localStorage.setItem("ml_cfg", JSON.stringify(c)); } catch (e) { /* ignore */ } }

  function openSettings() {
    var c = loadCfg();
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px";
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.25)">' +
      '<h3 style="margin:0 0 6px">Подключение модели</h3>' +
      '<p style="margin:0 0 12px;color:#5b636e;font-size:13px">Ключ хранится только в вашем браузере (localStorage) и уходит напрямую в выбранный API. Для публичного сайта лучше прокси — см. README.</p>' +
      '<label for="s_key">API-ключ</label><input id="s_key" type="password" autocomplete="off" style="width:100%;padding:9px;border:1px solid #e3e6ea;border-radius:9px;font:inherit" placeholder="ключ не нужен — подставит сервер" value="' + esc(c.apiKey || "") + '">' +
      '<label for="s_url">Base URL</label><input id="s_url" type="text" style="width:100%;padding:9px;border:1px solid #e3e6ea;border-radius:9px;font:inherit" placeholder="https://api.openai.com/v1" value="' + esc(c.baseUrl || "/api") + '">' +
      '<label for="s_model">Модель</label><input id="s_model" type="text" style="width:100%;padding:9px;border:1px solid #e3e6ea;border-radius:9px;font:inherit" placeholder="gpt-4o-mini" value="' + esc(c.model || "nvidia/nemotron-3-super-120b-a12b:free") + '">' +
      '<div style="display:flex;gap:8px;margin-top:16px"><button class="ghost" id="s_cancel" style="flex:1">Отмена</button><button class="primary" id="s_run" style="flex:1;margin:0">Сохранить и развернуть</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.remove(); });
    $("s_cancel").onclick = function () { ov.remove(); };
    $("s_run").onclick = function () {
      var cfg = {
        apiKey: $("s_key").value.trim(),
        baseUrl: $("s_url").value.trim(),
        model: $("s_model").value.trim()
      };
      saveCfg(cfg); ov.remove(); runExpand(cfg);
    };
  }

  // ---------- LLM-развёртывание ----------

  function emptySections() {
    var n = 0;
    if (!state.tasks) return 0;
    state.tasks.forEach(function (t) { if (!state.sections || !state.sections[t.key]) n++; });
    return n;
  }

  function runExpand(cfg) {
    // Прокси-режим: ключ не обязателен — подставляет сервер.
    if (!state.bp) generate();
    state.cfg = cfg;
    var depth = parseFloat(val("depth")) || 1;
    state.words = Math.min(700, Math.round(E.suggestWords(state.bp) * depth));
    state.tasks = P.buildTasks(state.bp, state.words);
    state.sections = {};
    state.errors = [];
    startExpand();
  }

  function startExpand() {
    if (state.ctrl) { try { state.ctrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    state.ctrl = ctrl;
    var done = 0, total = emptySections();
    showStatus("Развёртывание через модель… 0/" + total, true);

    L.expand(state.bp, state.cfg, {
      words: state.words,
      sections: state.sections,
      concurrency: 2,
      signal: ctrl ? ctrl.signal : null,
      onStart: function (t) { setStatusText("Пишется: " + t.title + " (" + done + "/" + total + ")"); },
      onProgress: function (d, tot) { done = d; setStatusText("Развёртывание… " + d + "/" + tot); }
    }).then(function (res) {
      state.ctrl = null;
      state.sections = res.sections;
      state.errors = res.errors;
      updateDraftTab();
      setActiveTab("draft");
      finishStatus();
    });
  }

  function showStatus(text, withCancel) {
    var el = $("status");
    el.innerHTML = '<span class="grow" id="status-text">' + esc(text) + '</span>' +
      (withCancel ? '<button class="ghost" id="cancel" style="flex:none;padding:6px 12px">Отмена</button>' : '');
    if (withCancel) $("cancel").onclick = function () {
      if (state.ctrl) state.ctrl.abort();
      setStatusText("Отменяем…");
    };
  }
  function setStatusText(text) { var el = $("status-text"); if (el) el.textContent = text; }
  function hideStatus() { $("status").innerHTML = ""; }

  function finishStatus() {
    var cancelled = state.errors.some(function (x) { return x.error && x.error.code === "CANCELLED"; });
    var n = emptySections();
    if (cancelled) {
      showStatus("Развёртывание отменено. Готовых секций: " + (state.tasks.length - n) + "/" + state.tasks.length + ".", false);
    } else if (state.errors.length) {
      showStatus("Готово с ошибками: " + (state.tasks.length - n) + "/" + state.tasks.length + " секций.", false);
    } else {
      showStatus("Готово: " + state.tasks.length + "/" + state.tasks.length + " секций.", false);
      setTimeout(hideStatus, 4000);
    }
    renderDraft(); // обновляет кнопки дозапуска и список ошибок
  }

  function renderDraft() {
    renderDraftInner();
    var d = $("pane-draft");
    var banner = '<div class="bookref" style="margin-bottom:12px">📖 Пишете текст? В книге Безруковой: <a href="' + BOOK_DIR + 'b04-glava-3.html#3-6-написание-текста" target="_blank" rel="noopener">§&nbsp;3.6 «Написание текста»</a> · <a href="' + BOOK_DIR + 'b04-glava-3.html#3-3-заключение-исследования" target="_blank" rel="noopener">§&nbsp;3.3 «Заключение»</a> · <a href="' + BOOK_DIR + 'b09-glava-8.html" target="_blank" rel="noopener">глава 8 «Оформление»</a></div>';
    if (d.innerHTML && d.innerHTML.indexOf("bookref") < 0) d.innerHTML = banner + d.innerHTML;
  }
  function renderDraftInner() {
    if (!state.bp || !state.tasks) { $("pane-draft").innerHTML = ""; return; }
    var rows = Math.max(8, Math.round(state.words / 12));
    var h = '<p class="muted tabhint">Отредактируйте секции — экспорт и печать используют отредактированный текст. Объём на секцию: ~' + state.words + ' слов.</p>';
    state.tasks.forEach(function (t) {
      var v = (state.sections && state.sections[t.key]) || "";
      var missing = !v ? ' <span style="color:var(--accent)">— не развёрнуто</span>' : "";
      h += '<div class="sec-edit"><h4>' + esc(t.title) + missing + '</h4>' +
        '<textarea data-key="' + esc(t.key) + '" rows="' + rows + '" spellcheck="false">' + esc(v) + '</textarea></div>';
    });
    h += '<details><summary>Предпросмотр черновика</summary><div class="preview" id="draft-preview"></div></details>';
    var n = emptySections();
    if (state.errors.length) {
      h += '<div class="errbox"><b>Ошибки последнего прогона:</b><ul>' +
        state.errors.filter(function (x) { return x.error && x.error.code !== "CANCELLED"; })
          .map(function (x) { return '<li>' + esc(x.task.title) + " — " + esc(x.error.message || x.error.code) + '</li>'; }).join('') +
        '</ul>' + (n ? '<button class="ghost" id="retry" style="padding:7px 12px">Повторить незаполненные (' + n + ')</button>' : '') + '</div>';
    } else if (n && state.sections) {
      h += '<div class="errbox"><button class="ghost" id="retry" style="padding:7px 12px">Доразвернуть незаполненные (' + n + ')</button></div>';
    }
    $("pane-draft").innerHTML = h;

    var retry = $("retry");
    if (retry) retry.onclick = function () {
      if (!state.cfg) return;
      startExpand();
    };
    var pv = $("draft-preview");
    if (pv) {
      var det = pv.parentElement;
      det.addEventListener("toggle", function () {
        if (det.open) pv.innerHTML = X.mdToHtml(L.assembleMarkdown(state.bp, state.sections));
      });
    }
  }

  $("llm").addEventListener("click", openSettings);

  // правки секций черновика пишутся прямо в state (делегирование, один слушатель)
  $("pane-draft").addEventListener("input", function (e) {
    var ta = e.target;
    if (ta.tagName === "TEXTAREA" && ta.dataset.key && state.sections) state.sections[ta.dataset.key] = ta.value;
  });

  // ---------- мелочи формы ----------

  $("gen").addEventListener("click", generate);
  $("topic").addEventListener("keydown", function (e) { if (e.key === "Enter") generate(); });
  $("kind").addEventListener("change", function () {
    $("emp").checked = this.value !== "referat";
    saveForm();
  });
  $("form").addEventListener("input", saveForm);
  $("form").addEventListener("change", saveForm);

  $("tab-bp").addEventListener("click", function () { setActiveTab("bp"); });
  $("tab-draft").addEventListener("click", function () { if (!$("tab-draft").disabled) setActiveTab("draft"); });

  // ---------- автозапуск: сохранённая форма, затем query-параметры (они важнее) ----------

  state.title = loadTitle();
  restoreForm();
  try {
    var q = new URLSearchParams(location.search);
    var hasQuery = false;
    if (q.get("topic")) { $("topic").value = q.get("topic"); hasQuery = true; }
    if (q.get("kind")) { $("kind").value = q.get("kind"); hasQuery = true; }
    if (q.get("field")) { $("field").value = q.get("field"); hasQuery = true; }
    if (q.get("vol")) { $("vol").value = q.get("vol"); }
    if (q.get("depth")) { $("depth").value = q.get("depth"); }
    if (q.get("extra")) { $("extra").value = q.get("extra"); }
    if (q.get("sources")) { $("sources").value = q.get("sources"); }
    if (q.has("emp")) { $("emp").checked = q.get("emp") === "1"; }
    if (q.has("app")) { $("app").checked = q.get("app") === "1"; }
    if (hasQuery) generate();
  } catch (e) { /* ignore */ }
})();
