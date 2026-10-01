/* test_export.mjs — тест экспорта: md→HTML конвертер, автономный .html, Word .doc */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const E = require("../frontend/engine.js");
const L = require("../frontend/llm.js");
const X = require("../frontend/export.js");

let pass = 0, fail = 0;
function ok(c, m){ if(c){pass++;} else {fail++; console.log("  FAIL:", m);} }

// 1) экранирование
ok(X.esc('<a href="x">&') === "&lt;a href=&quot;x&quot;&gt;&amp;", "esc: html + кавычки");

// 2) инлайн-разметка
ok(X.mdToHtml("**жирный**").includes("<strong>жирный</strong>"), "bold");
ok(X.mdToHtml("_курсив_").includes("<em>курсив</em>"), "italic");
ok(X.mdToHtml("[текст](https://example.com)").includes('<a href="https://example.com"'), "link");
ok(!X.mdToHtml("[источник]").includes("<a "), "плейсхолдер [источник] не становится ссылкой");

// 3) блочная разметка
ok(X.mdToHtml("# Заголовок").includes("<h1>Заголовок</h1>"), "h1");
ok(X.mdToHtml("### Параграф").includes("<h3>Параграф</h3>"), "h3");
ok(X.mdToHtml("1. первый\n2. второй").includes("<ol><li>первый</li><li>второй</li></ol>"), "ol");
ok(X.mdToHtml("- а\n- б").includes("<ul><li>а</li><li>б</li></ul>"), "ul");
ok(X.mdToHtml("> цитата").includes("<blockquote>цитата</blockquote>"), "blockquote");
ok(X.mdToHtml("---").includes("<hr>"), "hr");
const pre = X.mdToHtml("```text\nВВЕДЕНИЕ\n1) задача\n```");
ok(pre.includes("<pre>ВВЕДЕНИЕ\n1) задача</pre>"), "код-блок как есть");

// 4) смешанный markdown из движка конвертируется без потерь темы
const bp = E.buildBlueprint({ topic: "Отчуждение труда в сфере образования", kind: "diplom", field: "философия" });
const html = X.mdToHtml(E.toMarkdown(bp));
ok(html.includes("<h1>") && html.includes("<h2>1. Актуальность</h2>"), "каркас: заголовки секций");
ok(html.includes("Отчуждение труда"), "каркас: тема в html");
ok(!html.includes("<script"), "нет script в выводе");
ok(html.includes('href="https://cyberleninka.ru/'), "ссылка на КиберЛенинку");

// 5) черновик тоже конвертируется
const draft = L.assembleMarkdown(bp, { intro: "Текст введения.", concl: "Текст заключения." });
const dhtml = X.mdToHtml(draft);
ok(dhtml.includes("## ") === false && dhtml.includes("<h2>Введение</h2>"), "черновик: введение");

// 6) автономный HTML
const page = X.buildStandaloneHtml("Тема работы", "# Каркас\n\nТекст.");
ok(page.startsWith("<!doctype html>") && page.includes("<title>Тема работы</title>"), "standalone: доктайп и титул");
ok(page.includes("<h1>Каркас</h1>"), "standalone: содержимое");

// 7) Word .doc
const doc = X.buildWordHtml("Тема работы", "# Каркас\n\nТекст.");
ok(doc.charCodeAt(0) === 0xfeff, "word: BOM для UTF-8");
ok(doc.includes("schemas-microsoft-com:office:word"), "word: неймспейсы Word");
ok(doc.includes("Times New Roman"), "word: шрифт Times New Roman");
ok(doc.includes("<h1>Каркас</h1>"), "word: содержимое");

// 8) инъекция экранируется в экспортных форматах
const evil = E.buildBlueprint({ topic: '<img src=x onerror=alert(1)>' });
const evilHtml = X.buildStandaloneHtml("t", E.toMarkdown(evil));
ok(!evilHtml.includes("<img"), "злая тема экранирована в standalone html");

// 9) титульный лист
const tp = { org: '[ВУЗ <"тест">]', chair: "Кафедра философии", kindLabel: "курсовая работа",
  topic: "Отчуждение труда", author: "Иванов И. И.", advisor: "проф. Петров П. П.",
  city: "Москва", year: "2026" };
const tpHtml = X.buildTitlePageHtml(tp);
ok(tpHtml.includes("class=\"titlepage\""), "титул: секция");
ok(tpHtml.includes("на тему: «Отчуждение труда»") && tpHtml.includes("Иванов И. И."), "титул: тема и автор");
ok(!tpHtml.includes('<"тест">'), "титул: экранирование");

// 10) титульный лист вставляется в экспорт с разрывом страницы
const withTp = X.buildWordHtml("t", "# Заголовок", { titlePage: tpHtml });
ok(withTp.indexOf('class="titlepage"') < withTp.indexOf("<h1>Заголовок</h1>"), "doc: титул до содержимого");
ok(withTp.includes("page-break-after:always"), "doc: css разрыва страницы после титула");
const withTpHtml = X.buildStandaloneHtml("t", "# Заголовок", { titlePage: tpHtml });
ok(withTpHtml.includes(".titlepage") && withTpHtml.indexOf('class="titlepage"') < withTpHtml.indexOf("<h1>Заголовок</h1>"), "html: титул + css разрыва");
ok(withTpHtml.includes("page-break-after:always"), "html: css разрыва страницы");
ok(X.buildStandaloneHtml("t", "# Х").indexOf('class="titlepage"') === -1, "html: без опции — без титула");

console.log("\n==== EXPORT RESULT: pass=" + pass + " fail=" + fail + " ====");
process.exit(fail?1:0);
