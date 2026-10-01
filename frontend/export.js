/* export.js — экспорт без зависимостей: Markdown → HTML, автономный .html для скачивания,
   HTML-документ для Word (.doc, открывается в Word/LibreOffice). Рассчитан на Markdown,
   который генерируют сам движок и сборщик черновика (заголовки, списки, цитата, **жирный**,
   _курсив_, [ссылки](url), горизонтальная черта, код-блок ```). */
(function (global, factory) {
  var api = factory(global);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.MLExport = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function (global) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Инлайн-разметка: **жирный**, _курсив_, [текст](http…)
  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }

  function mdToHtml(md) {
    var lines = String(md == null ? "" : md).split(/\r?\n/);
    var out = [], para = [], quote = [], list = null, code = [], inCode = false;

    function flushPara() { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } }
    function flushQuote() { if (quote.length) { out.push("<blockquote>" + inline(quote.join(" ")) + "</blockquote>"); quote = []; } }
    function flushList() {
      if (list) { out.push("<" + list.type + ">" + list.items.map(function (li) { return "<li>" + inline(li) + "</li>"; }).join("") + "</" + list.type + ">"); list = null; }
    }
    function flushAll() { flushPara(); flushQuote(); flushList(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^```/.test(line)) {
        flushAll();
        if (inCode) { out.push("<pre>" + esc(code.join("\n")) + "</pre>"); code = []; }
        inCode = !inCode;
        continue;
      }
      if (inCode) { code.push(line); continue; }

      if (!line.trim()) { flushAll(); continue; }

      var h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { flushAll(); var lvl = h[1].length; out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">"); continue; }

      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushAll(); out.push("<hr>"); continue; }

      if (/^>\s?/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^>\s?/, "")); continue; }
      flushQuote();

      var ol = line.match(/^\d+[.)]\s+(.*)$/);
      if (ol) { flushPara(); if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; } list.items.push(ol[1]); continue; }

      var ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) { flushPara(); if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; } list.items.push(ul[1]); continue; }

      flushList();
      para.push(line.trim());
    }
    if (inCode && code.length) out.push("<pre>" + esc(code.join("\n")) + "</pre>");
    flushAll();
    return out.join("\n");
  }

  var BASE_CSS =
    "body{font-family:Georgia,'Times New Roman',serif;max-width:780px;margin:32px auto;padding:0 18px;line-height:1.65;color:#141414}" +
    "h1{font-size:24px;line-height:1.3}h2{font-size:19px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}" +
    "h3{font-size:16px;margin:20px 0 6px}h4{font-size:14.5px;margin:16px 0 4px}" +
    "blockquote{border-left:3px solid #b0181c;margin:12px 0;padding:6px 14px;background:#faf7f2;color:#4a4a4a}" +
    "pre{background:#f4f4f4;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px;font-family:Consolas,Menlo,monospace}" +
    "ol,ul{margin:8px 0 8px 24px;padding:0}li{margin:4px 0}a{color:#b0181c}hr{border:0;border-top:1px solid #ddd;margin:20px 0}" +
    "@media print{body{margin:0;max-width:none}}";

  var TITLEPAGE_CSS =
    ".titlepage{text-align:center;page-break-after:always;padding:40px 0 20px}" +
    ".titlepage .tp-top{margin:2px 0}" +
    ".titlepage .tp-kind{margin:70px 0 10px;text-transform:uppercase;letter-spacing:.5px;font-weight:600}" +
    ".titlepage .tp-topic{font-size:17px;font-weight:600;max-width:520px;margin:0 auto}" +
    ".titlepage .tp-right{margin:90px auto 0;text-align:right;max-width:380px}" +
    ".titlepage .tp-bottom{margin-top:120px}";

  // Титульный лист учебной работы (плейсхолдеры заполняются в UI или в Word).
  // tp: {org, chair, kindLabel, topic, author, advisor, city, year}
  function buildTitlePageHtml(tp) {
    return '<section class="titlepage">' +
      '<p class="tp-top">' + esc(tp.org) + '</p>' +
      '<p class="tp-top">' + esc(tp.chair) + '</p>' +
      '<p class="tp-kind">' + esc(tp.kindLabel) + '</p>' +
      '<p class="tp-topic">на тему: «' + esc(tp.topic) + '»</p>' +
      '<div class="tp-right"><p>Выполнил(а): ' + esc(tp.author) + '</p>' +
      '<p>Руководитель: ' + esc(tp.advisor) + '</p></div>' +
      '<p class="tp-bottom">' + esc(tp.city) + ', ' + esc(tp.year) + '</p>' +
      '</section>';
  }

  // Автономная HTML-страница для скачивания. opts.titlePage — html-фрагмент титульного листа.
  function buildStandaloneHtml(title, md, opts) {
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>" + esc(title) + "</title><style>" + BASE_CSS + TITLEPAGE_CSS + "</style></head><body>" +
      ((opts && opts.titlePage) ? opts.titlePage : "") +
      mdToHtml(md) + "</body></html>";
  }

  // HTML-документ в формате Word: сохраняется как .doc и открывается в Word/Writer.
  // BOM помогает Word определить UTF-8 (кириллица). opts.titlePage — титульный лист.
  function buildWordHtml(title, md, opts) {
    return "\ufeff<html xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:w=\"urn:schemas-microsoft-com:office:word\">" +
      "<head><meta charset=\"utf-8\"><title>" + esc(title) + "</title><style>" +
      "@page{size:A4;margin:2cm 1.5cm 2cm 1.5cm}" +
      "body{font-family:'Times New Roman',serif;font-size:14pt;line-height:1.5;color:#000}" +
      "h1{font-size:18pt;text-align:center}h2{font-size:16pt}h3{font-size:14pt}h4{font-size:14pt;font-style:italic}" +
      "blockquote{margin-left:1cm;font-size:12pt;color:#333}pre{font-family:'Times New Roman',serif;font-size:12pt;white-space:pre-wrap}" +
      "a{color:#000;text-decoration:none}" +
      ".titlepage{text-align:center;page-break-after:always}" +
      ".titlepage .tp-kind{margin:60pt 0 12pt;text-transform:uppercase;font-weight:600}" +
      ".titlepage .tp-topic{font-size:16pt;font-weight:600}" +
      ".titlepage .tp-right{margin:80pt auto 0 auto;text-align:right;max-width:300pt}" +
      ".titlepage .tp-bottom{margin-top:120pt}" +
      "</style></head><body>" +
      ((opts && opts.titlePage) ? opts.titlePage : "") +
      mdToHtml(md) + "</body></html>";
  }

  return { esc: esc, mdToHtml: mdToHtml, buildStandaloneHtml: buildStandaloneHtml,
    buildWordHtml: buildWordHtml, buildTitlePageHtml: buildTitlePageHtml };
});
