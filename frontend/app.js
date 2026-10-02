/* app.js — логика интерфейса: форма → каркас → вкладки «Каркас»/«Утверждения»/«Черновик»,
   конструктор гипотезы и новизны, реестр утверждений с локальным линтером,
   исследовательские режимы LLM (обзор, проверка, сравнение, критика, экспертиза), экспорт, шаринг,
   развёртывание со статусом, отменой и дозапуском. */
(function () {
  "use strict";
  var E = window.MLResearchEngine, P = window.MLPrompts, L = window.MLLlm, X = window.MLExport,
      R = window.MLResearch, M = window.MLModel;

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
    title: null,     // данные титульного листа
    model: null,     // реестр утверждений и источников (research-model.js)
    questionsEdited: false,
    modeCtrl: null   // AbortController одного запроса режима
  };

  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? el.value : ""; }
  function chk(id) { var el = $(id); return el ? el.checked : false; }
  function esc(s) { return X.esc(s); }

  // ---------- форма ----------

  var FORM_IDS = ["topic", "kind", "vol", "field", "rtype", "depth", "extra", "sources", "emp", "app",
    "hyp_x", "hyp_y", "hyp_m", "hyp_c", "nov_basis",
    "rs_req", "rs_obs", "rs_gap", "rs_strong", "rs_weak", "nov_what", "nov_srcs", "nov_confirm"];

  function collect() {
    return {
      topic: val("topic"), kind: val("kind"), field: val("field"),
      hasEmpirical: chk("emp"), applied: chk("app"),
      volumePages: val("vol"), extraKeywords: val("extra"), sources: val("sources"),
      researchType: val("rtype"),
      hypX: val("hyp_x") || "", hypY: val("hyp_y") || "",
      hypM: val("hyp_m") || "", hypC: val("hyp_c") || "",
      rsRequired: val("rs_req") || "", rsObstacle: val("rs_obs") || "",
      rsGap: val("rs_gap") || "", strongSide: val("rs_strong") || "", weakSide: val("rs_weak") || "",
      noveltyTypes: Array.prototype.map.call(
        document.querySelectorAll("#nov-types input:checked"), function (el) { return el.value; }),
      noveltyBasis: val("nov_basis") || "",
      noveltyWhat: val("nov_what") || "",
      noveltyCheckSources: val("nov_srcs") || "",
      noveltyConfirmation: val("nov_confirm") || ""
    };
  }

  function formSnapshot() {
    var f = {};
    FORM_IDS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      f[id] = el.type === "checkbox" ? el.checked : el.value;
    });
    return f;
  }

  function saveForm() {
    try { localStorage.setItem("ml_form", JSON.stringify(formSnapshot())); }
    catch (e) { /* приватный режим и т.п. */ }
  }

  function applyForm(f) {
    if (!f) return;
    FORM_IDS.forEach(function (id) {
      if (!(id in f)) return;
      var el = $(id);
      if (!el) return; // поля конструкторов появляются после первой генерации
      if (el.type === "checkbox") el.checked = !!f[id]; else el.value = f[id];
    });
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
    var prevTasks = state.tasks, prevSections = state.sections;
    var bp = E.buildBlueprint(collect());
    if (state.questionsEdited && state.customQuestions && state.customQuestions.length) {
      bp.questions = state.customQuestions.filter(function (q) { return q.trim(); });
      if (!bp.questions.length) bp.questions = E.researchQuestions(bp.meta);
    }
    state.bp = bp;
    state.md = E.toMarkdown(bp);
    // Черновик переживает перегенерацию, если структура глав не изменилась
    // (правки гипотезы/новизны/вопросов не должны стирать развёрнутый текст).
    if (prevTasks && prevSections) {
      var newKeys = P.buildTasks(bp, state.words).map(function (t) { return t.key; }).join("|");
      var oldKeys = prevTasks.map(function (t) { return t.key; }).join("|");
      if (newKeys === oldKeys) { state.tasks = prevTasks; state.sections = prevSections; }
    }
    if (!state.tasks) { state.sections = null; state.tasks = null; }
    state.errors = [];
    updateDraftTab();
    renderTitlePage();
    renderBlueprint();
    renderClaims();
    updateCompleteness();
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
    h += '<div class="kv"><p><b>' + esc(m.topic) + '</b></p><p class="muted">Область: ' + esc(m.field || "общая") + ' · Объём: ~' + esc(String(m.volumePages)) + ' с. · Тип исследования: ' + esc(bp.researchTypeLabel) + ' · Профиль дисциплины: ' + esc(bp.preset) + '</p></div>';
    h += '<div class="errbox" style="background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-fg)">' +
      '<b>Проверка аппарата</b> (связи по гл. 2 Безруковой' +
      (bp.apparatusCheck.errs ? ', ❌ ошибок: ' + bp.apparatusCheck.errs : '') +
      (bp.apparatusCheck.warns ? ', ⚠️ предупреждений: ' + bp.apparatusCheck.warns : '') + '):<ul>' +
      bp.apparatusCheck.items.map(function (i) {
        var mark = i.st === "ok" ? "✅" : i.st === "warn" ? "⚠️" : "❌";
        return '<li>' + mark + ' <b>' + esc(i.link) + '</b> — ' + esc(i.msg) + '</li>';
      }).join('') + '</ul></div>';
    h += '<h2 class="sec">Исследовательские вопросы (черновик — уточните)</h2>' +
      '<div class="kv"><p class="muted">Вопросы — до готового аппарата: ответ на них и рождает противоречие, гипотезу, задачи. Кнопка «Обзор» на вкладке «Утверждения» поможет.</p>' +
      '<textarea id="questions" rows="' + Math.max(4, bp.questions.length) + '" spellcheck="false">' + esc(bp.questions.join("\n")) + '</textarea>' +
      '<p class="muted">Правки применяются при следующем «Построить каркас» и попадают в промпты и research-бриф.</p></div>';
    h += bookTip("Актуальность");
    h += '<h2 class="sec">Актуальность</h2><div class="kv"><p>' + esc(bp.actualnost) + '</p>' +
      '<p><b>Противоречие.</b> ' + esc(bp.contradiction) + '</p><p><b>Проблема.</b> ' + esc(bp.problem) + '</p></div>';
    // «Выявить противоречие» — гл. 2 Безруковой: заказ/теория/практика → несоответствие → звенья
    h += '<h2 class="sec">Выявить противоречие (из материала, а не шаблон)</h2><div class="kv">' +
      '<p class="muted">Безрукова: противоречие вырастает из несоответствий между заказом, теорией и практикой; из него выделяется слабое звено. Заполните — и противоречие выше пересоберётся из вашего материала.</p>' +
      '<textarea id="rs_req" rows="2" placeholder="Что уже требуется / существует (заказ, практика, работающие решения)">' + esc(m.rsRequired) + '</textarea>' +
      '<textarea id="rs_obs" rows="2" placeholder="Что этому препятствует (в теории или на практике)">' + esc(m.rsObstacle) + '</textarea>' +
      '<textarea id="rs_gap" rows="2" placeholder="Где именно обнаружен разрыв">' + esc(m.rsGap) + '</textarea>' +
      '<div class="row"><textarea id="rs_strong" rows="2" placeholder="Сильное звено — что уже работает">' + esc(m.strongSide) + '</textarea>' +
      '<textarea id="rs_weak" rows="2" placeholder="Слабое звено — узкое место исследования">' + esc(m.weakSide) + '</textarea></div>' +
      '<div class="btns"><button class="ghost" id="rs_hint" style="flex:none">Подсказать разложение материала (LLM)</button></div>' +
      '<div id="rs-hint-result"></div>' +
      (bp.contradictionReady ? '<p class="muted">✅ Противоречие собрано из материала.</p>' : '<p class="muted">⚠ Противоречие пока шаблонное — нужны первые два поля.</p>') +
      '</div>';
    h += bookTip("Объект и предмет");
    h += '<h2 class="sec">Объект и предмет</h2><div class="kv"><p><b>Объект:</b> ' + esc(bp.object) + '</p><p><b>Предмет:</b> ' + esc(bp.subject) + '</p></div>';
    h += bookTip("Цель и задачи");
    h += '<h2 class="sec">Цель и задачи</h2><div class="kv"><p><b>Цель:</b> ' + esc(bp.goal) + '.</p><p><b>Задачи:</b></p><ol>' + bp.tasks.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
    if (bp.hypothesis) {
      h += bookTip("Гипотеза");
      h += '<h2 class="sec">Гипотеза — конструктор</h2><div class="kv"><p>' + esc(bp.hypothesis) + '</p>' +
        (bp.meta.hasEmpirical ?
        '<p class="muted">Содержательная гипотеза = Если X, то Y, потому что M, при условиях A и B. Универсальная формулировка не подставляется — заполните части и соберите.</p>' +
        '<div class="row"><input id="hyp_x" type="text" placeholder="X — фактор или воздействие" value="' + esc(m.hypX) + '"></div>' +
        '<div class="row"><input id="hyp_y" type="text" placeholder="Y — ожидаемое изменение" value="' + esc(m.hypY) + '"></div>' +
        '<div class="row"><input id="hyp_m" type="text" placeholder="M — механизм связи X и Y" value="' + esc(m.hypM) + '"></div>' +
        '<div class="row"><input id="hyp_c" type="text" placeholder="Условия A и B" value="' + esc(m.hypC) + '"></div>' : '') +
        '</div>';
    }
    h += bookTip("Методы");
    h += '<h2 class="sec">Методы</h2><div class="kv"><p><b>Теоретические:</b> ' + esc(bp.methods.theoretical.join('; ')) + '</p><p><b>Эмпирические:</b> ' + esc(bp.methods.empirical.join('; ')) + '</p></div>';
    h += bookTip("Этапы");
    h += '<h2 class="sec">Этапы</h2><ol>' + bp.stages.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    h += '<h2 class="sec">Научная новизна — прогноз автора</h2><div class="kv">' +
      '<p class="muted">Новизна не генерируется: по Безруковой она устанавливается после сопоставления с уже известным, поэтому фиксируется прогноз — что нового, на каком основании, с чем сверять, что считать подтверждением.</p>' +
      '<div class="checks" id="nov-types">' + Object.keys(E.NOVELTY_TYPES).map(function (t) {
        var on = m.noveltyTypes.indexOf(t) >= 0;
        return '<label><input type="checkbox" value="' + t + '"' + (on ? " checked" : "") + ' /> ' + esc(E.NOVELTY_TYPES[t]) + '</label>';
      }).join('') + '</div>' +
      '<textarea id="nov_what" rows="2" placeholder="Что предположительно нового">' + esc(m.noveltyWhat) + '</textarea>' +
      '<textarea id="nov_basis" rows="2" placeholder="На основании чего это предполагается">' + esc(m.noveltyBasis) + '</textarea>' +
      '<input id="nov_srcs" type="text" placeholder="Источники, с которыми нужно сопоставить" value="' + esc(m.noveltyCheckSources) + '">' +
      '<input id="nov_confirm" type="text" placeholder="Что будет считаться подтверждением" value="' + esc(m.noveltyConfirmation) + '">' +
      '<p class="kv"><b>Практическая значимость:</b> ' + esc(bp.significance) + '</p></div>';
    // Прогноз → результат (принцип Безруковой: прогноз сверяется с фактическим итогом)
    var oc = (state.model && state.model.outcome) || { noveltyActual: "", significanceActual: "", comparison: "" };
    h += '<h2 class="sec">Новизна и значимость: прогноз → результат</h2><div class="kv">' +
      '<p class="muted">После работы зафиксируйте фактический итог и сопоставьте с прогнозом — это и есть обоснование новизны (не декларация).</p>' +
      '<textarea id="out_nov" rows="2" placeholder="Фактическая новизна — что подтвердилось из прогноза">' + esc(oc.noveltyActual) + '</textarea>' +
      '<textarea id="out_sig" rows="2" placeholder="Фактическая практическая значимость">' + esc(oc.significanceActual) + '</textarea>' +
      '<textarea id="out_cmp" rows="2" placeholder="Сопоставление с прогнозом (или попросите модель ниже)">' + esc(oc.comparison) + '</textarea>' +
      '<div class="btns"><button class="ghost" id="out_btn" style="flex:none">Сопоставить прогноз и результат (LLM)</button></div>' +
      '<div id="out-result"></div></div>';
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
    var q = $("questions");
    if (q) q.addEventListener("input", function () {
      state.customQuestions = this.value.split("\n");
      state.questionsEdited = true;
      if (state.bp) state.bp.questions = state.customQuestions.filter(function (x) { return x.trim(); });
      saveForm();
      updateCompleteness();
    });
    var rh = $("rs_hint");
    if (rh) rh.onclick = function () { runMode(P.contradictionHintPrompt(state.bp), "rs-hint-result"); };
    var ob = $("out_btn");
    if (ob) ob.onclick = function () {
      var oc = (state.model && state.model.outcome) || {};
      runMode(P.outcomeComparePrompt(state.bp, oc), "out-result");
    };
    $("dl-orx").addEventListener("click", function () {
      download(safeFile(bp) + "_RESEARCH_BRIEF.md", R.buildResearchBrief(bp, state.model), "text/markdown;charset=utf-8");
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

  // ---------- вкладка «Утверждения»: реестр утверждений, источники и линтер ----------

  function loadModel() {
    try { return M.deserialize(localStorage.getItem("ml_model_v1")); }
    catch (e) { return M.emptyModel(); }
  }
  function saveModel() {
    try { localStorage.setItem("ml_model_v1", M.serialize(state.model)); } catch (e) { /* ignore */ }
  }

  function completenessCtx() {
    var total = state.tasks ? state.tasks.length : 0;
    var filled = 0;
    if (state.sections && total) {
      state.tasks.forEach(function (t) { if (state.sections[t.key]) filled++; });
    }
    var critTotal = state.bp ? (E.QUALITY_CRITERIA[state.bp.meta.kind] || []).length : 0;
    return {
      topicReady: !!state.bp && state.bp.meta.topic !== "«[укажите тему]»",
      hasEmpirical: !!state.bp && state.bp.meta.hasEmpirical,
      hypothesisReady: !!state.bp && state.bp.hypothesisReady,
      contradictionReady: !!state.bp && state.bp.contradictionReady,
      noveltyReady: !!state.bp && state.bp.noveltyReady,
      questionsReady: state.questionsEdited,
      selfReviewTotal: critTotal,
      outcomeExpected: !!state.bp,
      draftRatio: total ? filled / total : null
    };
  }

  function updateCompleteness() {
    var el = $("compl");
    if (!el) return;
    if (!state.bp) { el.style.display = "none"; return; }
    el.style.display = "";
    var c = M.completeness(state.model || M.emptyModel(), completenessCtx());
    el.textContent = "Готовность: " + c.percent + "%";
    el.title = c.items.map(function (i) { return (i.done ? "✓ " : "◻ ") + i.name; }).join("\n");
  }

  function renderClaims() {
    if (!state.model) state.model = loadModel();
    var mod = state.model, aud = M.audit(mod);
    var h = '<p class="muted tabhint">Реестр утверждений и источников: каждое существенное «следовательно» получает ID, тип и доказательство. Текст ссылается на ID, линтер показывает покрытие.</p>';

    // Линтер (локально, без сети)
    h += '<div class="errbox" style="background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-fg)">' +
      '<b>Аудит исследования:</b> утверждений ' + aud.total + ', с доказательством ' + aud.withSource +
      ', без ' + aud.withoutSource + (aud.coverage != null ? ' (покрытие ' + aud.coverage + '%)' : '') +
      ' · источников ' + aud.sources + ', резолвятся ' + aud.sourcesResolved + ', с конспектом ' + aud.sourcesWithNotes;
    var warn = [];
    if (aud.unbackedCausal.length) warn.push('причинных без источника: ' + aud.unbackedCausal.map(function (c) { return c.id; }).join(", "));
    if (aud.unbackedQuant.length) warn.push('количественных без источника: ' + aud.unbackedQuant.map(function (c) { return c.id; }).join(", "));
    if (aud.unbackedHistorical.length) warn.push('исторических без источника: ' + aud.unbackedHistorical.map(function (c) { return c.id; }).join(", "));
    if (aud.unresolvedSources.length) warn.push('не резолвятся: ' + aud.unresolvedSources.map(function (s) { return s.id; }).join(", "));
    h += (warn.length ? '<br>⚠ ' + esc(warn.join(" · ")) : '<br>✓ проблемных утверждений нет');
    h += '</div>';

    // Режимы исследования (LLM)
    h += '<div class="btns" style="margin-bottom:6px">' +
      '<button class="ghost" id="mode-explore">Обзор — карта темы</button>' +
      '<button class="ghost" id="mode-compare">Сравнение — матрица подходов</button>' +
      '</div>';

    // Источники
    h += '<h2 class="sec">Источники (менеджер источников)</h2>';
    if (mod.sources.length) {
      h += '<ol>' + mod.sources.map(function (s) {
        return '<li><b>' + esc(s.id) + '</b>. ' + esc([s.author, s.title, s.year ? "(" + s.year + ")" : ""].filter(Boolean).join(" ")) +
          (s.doi ? ' · doi:' + esc(s.doi) : '') + (s.url ? ' · <a href="' + esc(s.url) + '" target="_blank" rel="noopener">ссылка</a>' : '') +
          ' · надёжность: ' + esc(s.reliability) + (M.sourceResolved(s) ? '' : ' · <span style="color:var(--accent)">[не резолвится]</span>') +
          (s.resolved && s.resolvedMeta ? '<br><span class="muted">✅ Crossref: ' + esc(M.gostLine(Object.assign({}, s, s.resolvedMeta))) + '</span>' : '') +
          ' <button class="ghost" data-resolve="' + esc(s.id) + '" style="padding:1px 8px;font-size:12px" title="Проверить по Crossref и нормализовать запись">Резолвить</button>' +
          ' <button class="ghost" data-delsrc="' + esc(s.id) + '" style="padding:1px 8px;font-size:12px">✕</button></li>';
      }).join('') + '</ol>' +
        '<p class="muted">Резолвер проверяет DOI/название по Crossref и нормализует запись (русские источники там редки — «не найдено» не ошибка). Если CSP сайта станет enforcing, добавьте api.crossref.org в connect-src.</p>';
    } else {
      h += '<p class="muted">Источников пока нет. Модель запрещено доверять библиографию — добавляйте только проверенные вами.</p>';
    }
    h += '<div class="row"><input id="src_title" type="text" placeholder="Название работы (обязательно)">' +
      '<input id="src_author" type="text" placeholder="Автор"></div>' +
      '<div class="row"><input id="src_year" type="text" placeholder="Год" style="max-width:90px">' +
      '<input id="src_url" type="text" placeholder="URL">' +
      '<input id="src_doi" type="text" placeholder="DOI" style="max-width:160px"></div>' +
      '<div class="row"><select id="src_type"><option value="paper">статья</option><option value="book">книга</option>' +
      '<option value="data">данные/статистика</option><option value="primary">первичный источник</option><option value="web">веб</option></select>' +
      '<select id="src_rel"><option value="high">надёжность: высокая</option><option value="medium" selected>средняя</option><option value="low">низкая</option></select>' +
      '<button class="ghost" id="src_add" style="flex:none">Добавить источник</button></div>';

    // Конспекты источников (гл. 4 Безруковой)
    var NOTE_LABELS = { concepts: "Основные понятия", positions: "Основные положения", theses: "Тезисы",
      facts: "Факты", authorHypotheses: "Гипотезы автора", conclusions: "Выводы",
      quotes: "Цитаты (точные — со страницей)", remarks: "Мои замечания / критика",
      tasks: "Связь с задачами (№)", sections: "Связь с параграфами" };
    if (mod.sources.length) {
      h += '<h2 class="sec">Конспекты источников (гл. 4)</h2>' +
        '<p class="muted">Безрукова: конспект выделяет понятия, положения, тезисы, факты, гипотезы автора и выводы — и связывает их с задачами и параграфами вашей работы.</p>';
      mod.sources.forEach(function (s) {
        var marked = M.noteFilled(s) ? " ✏️" : "";
        h += '<details class="srcnote"><summary>Конспект ' + esc(s.id) + ' — ' + esc(s.title.slice(0, 70)) + marked + '</summary>' +
          Object.keys(NOTE_LABELS).map(function (k) {
            var v = (s.notes && s.notes[k]) || "";
            return '<textarea data-note="' + esc(s.id) + ':' + k + '" rows="2" placeholder="' + esc(NOTE_LABELS[k]) + '">' + esc(v) + '</textarea>';
          }).join('') + '</details>';
      });
    }

    // Утверждения
    h += '<h2 class="sec">Утверждения (реестр)</h2>';
    if (mod.claims.length) {
      mod.claims.forEach(function (c) {
        h += '<div class="sec-edit" style="border:1px solid var(--line);border-radius:10px;padding:10px 12px">' +
          '<h4>' + esc(c.id) + ' · ' + M.STATUSES[c.status].label + '</h4>' +
          '<textarea data-claim-text="' + esc(c.id) + '" rows="2" spellcheck="false">' + esc(c.text) + '</textarea>' +
          '<div class="row" style="margin-top:6px">' +
          '<select data-claim-type="' + esc(c.id) + '">' + Object.keys(M.CLAIM_TYPES).map(function (t) {
            return '<option value="' + t + '"' + (c.type === t ? " selected" : "") + '>' + M.CLAIM_TYPES[t].label + '</option>';
          }).join('') + '</select>' +
          '<select data-claim-status="' + esc(c.id) + '">' + Object.keys(M.STATUSES).map(function (s) {
            return '<option value="' + s + '"' + (c.status === s ? " selected" : "") + '>' + M.STATUSES[s].label + '</option>';
          }).join('') + '</select></div>' +
          '<input data-claim-ev="' + esc(c.id) + '" type="text" placeholder="Доказательство: что и где подтверждает (цитата, данные)" value="' + esc(c.evidence) + '" style="margin-top:6px">' +
          '<div class="row" style="margin-top:6px;align-items:center">' +
          '<div class="checks" style="margin:0">' + mod.sources.map(function (s) {
            return '<label style="font-size:12px"><input type="checkbox" data-link="' + esc(c.id) + ':' + esc(s.id) + '"' +
              (c.sourceIds.indexOf(s.id) >= 0 ? " checked" : "") + ' /> ' + esc(s.id) + '</label>';
          }).join('') + (mod.sources.length ? "" : '<span class="muted">источников нет — добавьте выше</span>') + '</div>' +
          '<button class="ghost" data-verify="' + esc(c.id) + '" style="flex:none;padding:5px 10px;font-size:12.5px">Проверить</button>' +
          '<button class="ghost" data-delclaim="' + esc(c.id) + '" style="flex:none;padding:5px 10px;font-size:12.5px">✕</button>' +
          '</div></div>';
      });
    } else {
      h += '<p class="muted">Утверждений нет. Добавьте первое — например, из текста параграфа: каждое «следовательно» должно иметь основание.</p>';
    }
    h += '<div class="row"><input id="clm_text" type="text" placeholder="Новое утверждение (X влияет на Y / автор утверждает Z / …)">' +
      '<select id="clm_type" style="max-width:200px">' + Object.keys(M.CLAIM_TYPES).map(function (t) {
        return '<option value="' + t + '">' + M.CLAIM_TYPES[t].label + '</option>';
      }).join('') + '</select>' +
      '<button class="ghost" id="clm_add" style="flex:none">Добавить</button></div>';

    // Самоэкспертиза (гл. 10 Безруковой) — критерии качества для данного типа работы
    var crit = state.bp ? (E.QUALITY_CRITERIA[state.bp.meta.kind] || []) : [];
    if (crit.length) {
      var sr = M.selfReviewStats(mod, crit.length);
      h += '<h2 class="sec" id="sr-head">Самоэкспертиза (гл. 10) — ' + sr.done + '/' + crit.length + '</h2><div class="kv">' +
        '<p class="muted">Критерии качества из книги. Отмечайте по мере выполнения — самоэкспертиза у Безруковой часть аппарата, а не формальность.</p>' +
        '<div class="checks" id="sr-list">' + crit.map(function (c, i) {
          return '<label><input type="checkbox" data-sr="' + i + '"' + (sr.done[i] ? " checked" : "") + ' /> ' + esc(c) + '</label>';
        }).join('') + '</div>' +
        '<textarea id="sr_note" rows="2" placeholder="Заметки самоэкспертизы: что доработать в первую очередь">' + esc(sr.note) + '</textarea></div>';
    }

    h += '<details style="margin-top:14px"><summary>Реестр в Markdown (входит в экспорт и research-бриф)</summary><pre class="md">' +
      esc(M.toMarkdown(mod) || "_(пусто)_") + '</pre></details>';
    h += renderVersions();
    h += '<div id="mode-result"></div>';
    $("pane-claims").innerHTML = h;
    bindClaims();
    updateCompleteness();
  }

  function bindClaims() {
    // Прямые onclick по id — безопасно при каждом рендере (элементы пересоздаются).
    // Делегированные слушатели pane-claims навешиваются один раз в init (см. ниже).
    $("src_add").onclick = function () {
      var s = M.addSource(state.model, {
        title: val("src_title"), author: val("src_author"), year: val("src_year"),
        url: val("src_url"), doi: val("src_doi"), type: val("src_type"), reliability: val("src_rel")
      });
      if (!s) { alert("Название обязательно."); return; }
      saveModel(); renderClaims();
    };
    $("clm_add").onclick = function () {
      var c = M.addClaim(state.model, { text: val("clm_text"), type: val("clm_type") });
      if (!c) { alert("Текст утверждения обязателен."); return; }
      saveModel(); renderClaims();
    };
    $("mode-explore").onclick = function () { runMode(P.explorePrompt(state.bp)); };
    $("mode-compare").onclick = function () { runMode(P.comparePrompt(state.bp, window.prompt("Кого сравнить (через запятую)?", "Маркс, Вебер, современный автор") || "")); };
  }

  // Делегированные слушатели pane-claims — навешиваются ровно один раз (иначе каждый
  // renderClaims добавляет копию и один клик порождает несколько действий).
  function bindClaimsOnce() {
    $("pane-claims").addEventListener("input", function (e) {
      var t = e.target, mod = state.model;
      if (t.tagName !== "TEXTAREA" && t.tagName !== "INPUT" || !mod) return;
      if (t.dataset.note) {
        var np = t.dataset.note.split(":");
        var patch = {}; patch[np[1]] = t.value;
        M.updateNotes(mod, np[0], patch);
        saveModel(); updateCompleteness();
      }
      if (t.id === "sr_note") { M.setSelfReviewNote(mod, t.value); saveModel(); }
      if (t.dataset.claimText) { M.updateClaim(mod, t.dataset.claimText, { text: t.value }); saveModel(); updateCompleteness(); }
      if (t.dataset.claimEv) { M.updateClaim(mod, t.dataset.claimEv, { evidence: t.value }); saveModel(); }
    });
    $("pane-claims").addEventListener("change", function (e) {
      var t = e.target, mod = state.model;
      if (!mod) return;
      if (t.dataset && t.dataset.sr !== undefined && t.dataset.sr !== "") {
        M.updateSelfReview(mod, Number(t.dataset.sr), t.checked);
        saveModel();
        var crit = state.bp ? (E.QUALITY_CRITERIA[state.bp.meta.kind] || []) : [];
        var sr = M.selfReviewStats(mod, crit.length);
        var head = $("sr-head");
        if (head) head.textContent = "Самоэкспертиза (гл. 10) — " + sr.done + "/" + crit.length;
        updateCompleteness();
      }
      if (t.dataset.claimType) { M.updateClaim(mod, t.dataset.claimType, { type: t.value }); saveModel(); renderClaims(); }
      if (t.dataset.claimStatus) { M.updateClaim(mod, t.dataset.claimStatus, { status: t.value }); saveModel(); renderClaims(); }
      if (t.dataset.link) {
        var parts = t.dataset.link.split(":");
        if (t.checked) M.link(mod, parts[0], parts[1]);
        var c = mod.claims.filter(function (x) { return x.id === parts[0]; })[0];
        if (c && !t.checked) c.sourceIds = c.sourceIds.filter(function (s) { return s !== parts[1]; });
        saveModel(); renderClaims();
      }
    });
    $("pane-claims").addEventListener("click", function (e) {
      var t = e.target.closest("button");
      if (!t || !state.model) return;
      if (t.dataset.delsrc) { M.removeSource(state.model, t.dataset.delsrc); saveModel(); renderClaims(); }
      if (t.dataset.resolve) runResolve(t.dataset.resolve);
      if (t.dataset.restore) restoreVersion(Number(t.dataset.restore));
      if (t.id === "ver_add") { addVersion("зафиксирована вручную"); renderClaims(); }
      if (t.id === "ver_chlog") {
        download(safeFile(state.bp) + "_versions.md", versionsChangelog(), "text/markdown;charset=utf-8");
      }
      if (t.dataset.delclaim) { M.removeClaim(state.model, t.dataset.delclaim); saveModel(); renderClaims(); }
      if (t.dataset.verify) {
        var c = state.model.claims.filter(function (x) { return x.id === t.dataset.verify; })[0];
        if (c) runMode(P.verifyPrompt({ text: c.id + " «" + c.text + "»", type: M.CLAIM_TYPES[c.type].label }));
      }
    });
  }

  // Source resolver: проверка записи по Crossref (DOI напрямую или библиографический поиск).
  function runResolve(id) {
    var s = state.model.sources.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var box = $("mode-result");
    if (box) box.innerHTML = '<div class="status"><span class="grow" id="status-text">Резолвим ' + esc(id) + ' через Crossref…</span></div>';
    var q = s.doi
      ? "https://api.crossref.org/works/" + encodeURIComponent(s.doi)
      : "https://api.crossref.org/works?rows=3&query.bibliographic=" + encodeURIComponent((s.title + " " + (s.author || "")).trim());
    fetch(q)
      .then(function (r) { if (!r.ok) throw new Error("Crossref " + r.status); return r.json(); })
      .then(function (d) {
        var it = d && d.message && d.message.items ? d.message.items[0] : (d && d.message);
        var meta = M.parseCrossrefItem(it);
        if (!meta || !meta.title) throw new Error("Crossref ничего не нашёл — «не найдено» не ошибка для русскоязычных источников");
        M.updateSource(state.model, id, {
          title: meta.title, author: meta.author || s.author, year: meta.year || s.year,
          url: meta.url || s.url, doi: meta.doi || s.doi, resolved: true, resolvedMeta: meta
        });
        saveModel();
        renderClaims();
        var box2 = $("mode-result");
        if (box2) box2.innerHTML = '<div class="errbox" style="background:var(--warn-bg);border-color:var(--warn-line);color:var(--warn-fg)">✅ ' +
          esc(id) + ' резолвится: ' + esc(M.gostLine(Object.assign({}, state.model.sources.filter(function (x) { return x.id === id; })[0], meta))) +
          ' — проверьте совпадение с вашим источником.</div>';
      })
      .catch(function (e) {
        var box3 = $("mode-result");
        if (box3) box3.innerHTML = '<div class="errbox">Резолвер: ' + esc(String(e && e.message || e)) + '.</div>';
      });
  }

  // ---------- исследовательские режимы LLM (одноразовые запросы) ----------

  function activeCfg() {
    if (state.cfg) return state.cfg;
    try { return JSON.parse(localStorage.getItem("ml_cfg") || "{}"); } catch (e) { return {}; }
  }

  function runMode(prompt, boxId) {
    var box = $(boxId || "mode-result");
    var cfg = activeCfg();
    if (state.modeCtrl) { try { state.modeCtrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    state.modeCtrl = ctrl;
    box.innerHTML = '<div class="status"><span class="grow" id="mode-status">Модель думает…</span>' +
      (ctrl ? '<button class="ghost" id="mode-cancel" style="flex:none;padding:6px 12px">Отмена</button>' : '') + '</div>';
    var cancel = $("mode-cancel");
    if (cancel) cancel.onclick = function () { if (state.modeCtrl) state.modeCtrl.abort(); };
    L.chat([{ role: "system", content: P.MODE_SYSTEM }, { role: "user", content: prompt }], cfg, null,
      { signal: ctrl ? ctrl.signal : null })
      .then(function (text) {
        state.modeCtrl = null;
        box.innerHTML = '<div class="btns" style="margin:10px 0 4px"><button class="ghost" id="mode-copy" style="flex:none;padding:6px 12px">Копировать результат</button></div><pre class="md">' + esc(text) + '</pre>';
        $("mode-copy").onclick = function () { navigator.clipboard.writeText(text).then(function () { flashButton($("mode-copy"), "Скопировано"); }); };
      })
      .catch(function (e) {
        state.modeCtrl = null;
        box.innerHTML = '<div class="errbox">Ошибка режима: ' + esc((e && e.message) || e.code || String(e)) + '</div>';
      });
  }

  // ---------- версии исследования (v0.1 → v1.0) ----------

  function listVersions() {
    try { return JSON.parse(localStorage.getItem("ml_versions_v1") || "[]"); }
    catch (e) { return []; }
  }

  function addVersion(label) {
    var vs = listVersions();
    var filled = 0, total = state.tasks ? state.tasks.length : 0;
    if (state.sections && total) state.tasks.forEach(function (t) { if (state.sections[t.key]) filled++; });
    var v = {
      n: vs.length + 1, ts: Date.now(), label: label || "",
      form: formSnapshot(),
      model: M.serialize(state.model || M.emptyModel()),
      sections: state.sections || null,
      words: state.words,
      questions: state.questionsEdited ? state.customQuestions : null
    };
    vs.push(v);
    try { localStorage.setItem("ml_versions_v1", JSON.stringify(vs.slice(-30))); } catch (e) { return null; }
    return v.n;
  }

  function restoreVersion(n) {
    var v = listVersions().filter(function (x) { return x.n === n; })[0];
    if (!v) return;
    applyForm(v.form);      // базовые поля
    generate();             // после первой генерации появляются поля конструкторов
    applyForm(v.form);      // конструкторы (гипотеза/противоречие/новизна)
    generate();             // каркас из восстановленных значений
    if (v.questions) { state.customQuestions = v.questions; state.questionsEdited = true; }
    else { state.customQuestions = null; state.questionsEdited = false; }
    if (state.model) saveModel();
    state.model = M.deserialize(v.model);
    saveModel();
    if (v.sections) {
      state.words = v.words || state.words;
      state.tasks = P.buildTasks(state.bp, state.words);
      state.sections = v.sections;
      updateDraftTab();
      renderDraft();
    } else {
      state.sections = null; state.tasks = null;
      updateDraftTab();
    }
    renderBlueprint();
    renderClaims();
    updateCompleteness();
    setActiveTab("bp");
  }

  function renderVersions() {
    var vs = listVersions();
    var h = '<h2 class="sec">Версии исследования</h2><div class="kv">' +
      '<p class="muted">Снимок всего состояния (форма, аппарат, реестр, черновик). Автоверсия создаётся перед пайплайном «Критика→Правка», чтобы любую правку можно было откатить.</p>' +
      '<div class="btns"><button class="ghost" id="ver_add" style="flex:none">Зафиксировать версию (v0.' + (vs.length + 1) + ')</button>' +
      (vs.length ? '<button class="ghost" id="ver_chlog" style="flex:none">Скачать changelog .md</button>' : '') + '</div>';
    if (vs.length) {
      h += '<ul>' + vs.slice().reverse().map(function (v) {
        var d = new Date(v.ts);
        return '<li><b>v0.' + v.n + '</b> — ' + d.toLocaleDateString("ru") + " " + d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) +
          (v.label ? " — " + esc(v.label) : "") +
          ' <button class="ghost" data-restore="' + v.n + '" style="padding:1px 8px;font-size:12px">Восстановить</button></li>';
      }).join('') + '</ul>';
    }
    h += '</div><div id="ver-result"></div>';
    return h;
  }

  function versionsChangelog() {
    var vs = listVersions();
    var L = ["# История версий исследования «" + (state.bp ? state.bp.meta.topic : "") + "»", ""];
    vs.forEach(function (v) {
      var mod = M.deserialize(v.model);
      var d = new Date(v.ts);
      var secs = v.sections ? Object.keys(v.sections).filter(function (k) { return v.sections[k]; }).length : 0;
      L.push("- **v0." + v.n + "** — " + d.toLocaleDateString("ru") + " " + d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" }) +
        (v.label ? " — " + v.label : "") +
        " — утверждений: " + mod.claims.length + ", источников: " + mod.sources.length +
        ", секций черновика: " + secs);
    });
    L.push("");
    L.push("Правило трассировки: вывод в тексте → CLM-… → SRC-… → версия исследования.");
    return L.join("\n");
  }

  // ---------- вкладки ----------
  function setActiveTab(tab) {
    state.tab = tab;
    $("tab-bp").classList.toggle("active", tab === "bp");
    $("tab-claims").classList.toggle("active", tab === "claims");
    $("tab-draft").classList.toggle("active", tab === "draft");
    $("pane-bp").classList.toggle("active", tab === "bp");
    $("pane-claims").classList.toggle("active", tab === "claims");
    $("pane-draft").classList.toggle("active", tab === "draft");
  }

  function updateDraftTab() {
    var has = !!state.sections;
    $("tab-draft").disabled = !has;
    if (!has && state.tab === "draft") setActiveTab("bp");
  }

  // ---------- экспорт ----------

  function currentArtifact() {
    var tp = { titlePage: X.buildTitlePageHtml(tpData()) };
    var registry = (state.model && (state.model.claims.length || state.model.sources.length))
      ? "\n\n---\n\n" + M.toMarkdown(state.model) : "";
    if (state.tab === "draft" && state.sections) {
      var md = L.assembleMarkdown(state.bp, state.sections);
      return { title: state.bp.meta.topic, file: safeFile(state.bp) + "_черновик", md: titleMdText() + md + registry, opts: tp };
    }
    return { title: state.bp.meta.topic, file: safeFile(state.bp), md: titleMdText() + state.md + registry, opts: tp };
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
      if (state.pipeCtrl) state.pipeCtrl.abort();
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
    // Вставка через insertAdjacentHTML: перезапись innerHTML пересоздала бы элементы
    // и стёрла назначенные в renderDraftInner onclick (pipeline, critic и др.).
    var d = $("pane-draft");
    var banner = '<div class="bookref" style="margin-bottom:12px">📖 Пишете текст? В книге Безруковой: <a href="' + BOOK_DIR + 'b04-glava-3.html#3-6-написание-текста" target="_blank" rel="noopener">§&nbsp;3.6 «Написание текста»</a> · <a href="' + BOOK_DIR + 'b04-glava-3.html#3-3-заключение-исследования" target="_blank" rel="noopener">§&nbsp;3.3 «Заключение»</a> · <a href="' + BOOK_DIR + 'b09-glava-8.html" target="_blank" rel="noopener">глава 8 «Оформление»</a></div>';
    if (d.innerHTML && d.innerHTML.indexOf("bookref") < 0) d.insertAdjacentHTML("afterbegin", banner);
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
    h += '<div class="btns" style="margin-top:10px">' +
      '<button class="ghost" id="mode-critic">Критика текста</button>' +
      '<button class="ghost" id="mode-marx">Марксистская экспертиза категорий</button>' +
      '<button class="ghost" id="pipeline">Доработать черновик (Критика→Правка)</button></div>';
    h += '<p class="muted" id="pipeline-hint" style="margin-top:0">Пайплайн прогоняет каждую секцию через критику и правку; перед стартом создаётся автоверсия — откат в «Версиях исследования».</p>';
    h += '<div id="draft-mode-result"></div>';
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
    var mc = $("mode-critic"), mm = $("mode-marx"), pp = $("pipeline");
    if (mc) mc.onclick = function () {
      runMode(P.critiquePrompt(L.assembleMarkdown(state.bp, state.sections), state.bp), "draft-mode-result");
    };
    if (mm) mm.onclick = function () {
      runMode(P.marxistAuditPrompt(L.assembleMarkdown(state.bp, state.sections), state.bp), "draft-mode-result");
    };
    if (pp) pp.onclick = runPipeline;
  }

  // Writer→Critic→Revision: каждую секцию черновика прогоняем через критику и правку.
  // Перед стартом — автоверсия (откат в «Версиях исследования»).
  function runPipeline() {
    if (!state.sections || !state.tasks) { alert("Сначала разверните черновик через модель."); return; }
    addVersion("авто: перед Критика→Правка");
    if (state.pipeCtrl) { try { state.pipeCtrl.abort(); } catch (e) { /* ignore */ } }
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    state.pipeCtrl = ctrl;
    var fixable = state.tasks.filter(function (t) { return state.sections[t.key]; });
    var i = 0, fixed = 0, fails = 0, cancelled = false;
    function step() {
      if (i >= fixable.length) return finish();
      var t = fixable[i];
      var text = state.sections[t.key];
      showStatus("Пайплайн: критика «" + t.title + "» (" + (i + 1) + "/" + fixable.length + ")", true);
      return L.chat(
        [{ role: "system", content: P.MODE_SYSTEM }, { role: "user", content: P.critiquePrompt(text, state.bp) }],
        activeCfg(), null, { signal: ctrl ? ctrl.signal : null }
      ).then(function (cr) {
        showStatus("Пайплайн: правка «" + t.title + "» (" + (i + 1) + "/" + fixable.length + ")", true);
        return L.chat(
          [{ role: "system", content: P.MODE_SYSTEM }, { role: "user", content: P.revisionPrompt(t.title, text, cr, state.bp) }],
          activeCfg(), null, { signal: ctrl ? ctrl.signal : null }
        ).then(function (rev) { state.sections[t.key] = rev; fixed++; });
      }).catch(function (e) {
        if (e && e.code === "CANCELLED") cancelled = true;
        else fails++;
      }).then(function () {
        i++;
        if (cancelled) { i = fixable.length; } // прекращаем очередь
        step();
      });
    }
    function finish() {
      state.pipeCtrl = null;
      var msg = cancelled ? "Пайплайн остановлен: правок " + fixed + " из " + fixable.length + "."
        : (fails ? "Пайплайн готов с ошибками: правок " + fixed + ", сбоев " + fails + "." : "Пайплайн готов: правок " + fixed + "/" + fixable.length + ".");
      showStatus(msg + " Предыдущее состояние — в «Версиях исследования».", false);
      renderDraft();
      updateCompleteness();
    }
    step();
  }

  $("llm").addEventListener("click", openSettings);
  bindClaimsOnce();

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
  $("tab-claims").addEventListener("click", function () { setActiveTab("claims"); });
  $("tab-draft").addEventListener("click", function () { if (!$("tab-draft").disabled) setActiveTab("draft"); });

  // Конструкторы (гипотеза/противоречие/новизна): применяются на «change» (blur).
  $("pane-bp").addEventListener("change", function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    var regen = ["hyp_x", "hyp_y", "hyp_m", "hyp_c", "nov_basis", "nov_what", "nov_srcs", "nov_confirm",
      "rs_req", "rs_obs", "rs_gap", "rs_strong", "rs_weak"];
    if (regen.indexOf(t.id) >= 0) generate();
    if (t.closest && t.closest("#nov-types")) generate();
  });
  // Прогноз → результат пишется в модель без перегенерации.
  $("pane-bp").addEventListener("input", function (e) {
    var t = e.target;
    if (!t || !t.id || ["out_nov", "out_sig", "out_cmp"].indexOf(t.id) < 0) return;
    if (!state.model) state.model = loadModel();
    M.updateOutcome(state.model, {
      noveltyActual: val("out_nov"), significanceActual: val("out_sig"), comparison: val("out_cmp")
    });
    saveModel();
    updateCompleteness();
  });

  // ---------- автозапуск: сохранённая форма, затем query-параметры (они важнее) ----------

  state.title = loadTitle();
  state.model = loadModel();
  try { applyForm(JSON.parse(localStorage.getItem("ml_form") || "{}")); } catch (e) { /* ignore */ }
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
