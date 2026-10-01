/* research.js — сборка исследовательского брифа (handoff) для OpenResearch (alphaXiv, MIT).
   OpenResearch — local-first воркспейс (CLI `orx`, дашборд на 127.0.0.1:4791), превращающий
   кодинг-агентов в исследовательских: orx discover/paper для литературы, git-нативное дерево
   экспериментов (orx create-experiment / orx exp run). Публичного HTTP API нет, поэтому
   интеграция — само-достаточный Markdown-бриф: положите его в корень проекта OpenResearch
   как RESEARCH_BRIEF.md (или SKILL.md) и дайте агенту. Работает и с любым другим агентом. */
(function (global, factory) {
  var api = factory(global);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.MLResearch = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function (global) {
  "use strict";

  function P() { return (typeof require === "function") ? require("./prompts.js") : global.MLPrompts; }

  function buildResearchBrief(bp) {
    var Pp = P();
    var m = bp.meta, q = m.topic;
    var L = [];

    L.push("# Research brief: «" + q + "» (" + bp.kindLabel + ")");
    L.push("");
    L.push("> Сгенерировано «Методологическим ассистентом» (каркас по В. С. Безруковой, методология —");
    L.push("> ортодоксальный марксизм-ленинизм). Целевая среда — OpenResearch (alphaXiv): local-first");
    L.push("> воркспейс для кодинг-агентов, CLI `orx`. Бриф самодостаточен: сохраните как");
    L.push("> `RESEARCH_BRIEF.md` в корне проекта и укажите агенту его как задание.");
    L.push("");

    L.push("## 1. Методологическая позиция (системный промпт — соблюдать во всех текстах)");
    L.push("");
    L.push("```text");
    L.push(Pp.SYSTEM);
    L.push("```");
    L.push("");

    L.push("## 2. Аппарат исследования");
    L.push("");
    L.push("- **Тема:** " + q);
    L.push("- **Область / тип работы / объём:** " + m.field + " · " + bp.kindLabel + " · ~" + m.volumePages + " с.");
    L.push("- **Проблема:** " + bp.problem);
    L.push("- **Объект:** " + bp.object);
    L.push("- **Предмет:** " + bp.subject);
    L.push("- **Цель:** " + bp.goal);
    L.push("- **Гипотеза:** " + (bp.hypothesis || "— (работа теоретическая, эмпирическая проверка не предусмотрена)"));
    L.push("- **Научная новизна:** " + bp.novelty);
    L.push("");

    L.push("## 3. Направления исследования (задачи → ветви экспериментального дерева)");
    L.push("");
    bp.tasks.forEach(function (t, i) { L.push("- **D" + (i + 1) + ".** " + t); });
    L.push("");

    L.push("## 4. План экспериментального дерева (по правилам orx)");
    L.push("");
    L.push("- **Корень:** сбор/воспроизведение данных по проблеме — констатирующий этап" +
      (m.hasEmpirical ? " (фиксация исходного состояния явления)." : " (анализ источников)."));
    L.push("- **Дети корня:** по одному узлу на каждое направление D1–D" + bp.tasks.length +
      ". Гиперпараметры кодируйте в коде/конфиге, а не в команде запуска (run command — фиксированный контракт).");
    L.push("- **Расти вниз, а не вширь:** сначала веером в одном раунде, затем спуск на лучшем узле (promote);");
    L.push("  широкая корневая веерность без внуков — анти-паттерн. Узел с результатом не редактируется — ветвите дочерний.");
    L.push("- **После каждого завершённого прогона** выбирайте один ход: `repair` (перезапуск неотвеченного узла),");
    L.push("  `refill` (добавить сиблинга), `promote` (спуститься на победителя) или `stop`.");
    L.push("");

    L.push("## 5. Литература: сначала orx discover / orx paper, потом web-поиск");
    L.push("");
    L.push("```bash");
    L.push('orx discover "' + q + '"            # поиск по ключевой фразе (логин не нужен)');
    L.push('orx discover openalex "' + q + '"   # то же через OpenAlex');
    L.push("orx paper <arxiv-id | doi> --full    # полнотекстовая выжимка статьи");
    L.push("```");
    L.push("");
    L.push("Стартовый список (проверить наличие и оформить по ГОСТ):");
    L.push("");
    bp.literature.forEach(function (r, i) { L.push((i + 1) + ". " + r); });
    L.push("");
    L.push("Поиск вручную: " + bp.literatureLinks.map(function (l) { return "[" + l.label + "](" + l.url + ")"; }).join(" · "));
    L.push("");

    L.push("## 6. Ожидаемые артефакты (структура итоговой работы)");
    L.push("");
    L.push("- Введение и Заключение — по шаблонам каркаса (введение: актуальность → противоречие → проблема →");
    L.push("  объект/предмет → цель/задачи → гипотеза → методы; заключение: итоги по каждой задаче, судьба гипотезы, новизна, значимость, перспективы).");
    bp.structure.chapters.forEach(function (c) {
      L.push("- " + c.title + " — " + c.sub.join("; ") + ".");
    });
    L.push("- Данные, логи и результаты экспериментов остаются в дереве orx с привязкой к прогонам;");
    L.push("  вымышленные числа недопустимы — непроверенное помечать `[источник]`/`[данные]`.");
    L.push("");

    L.push("## 7. Честность и ответственность");
    L.push("");
    L.push("- Бриф — учебно-методический каркас: итоговый текст принадлежит автору работы.");
    L.push("- Факты, цитаты и библиографические данные проверяются вручную; выдумывать источники запрещено.");
    L.push("- Идеологическая рамка (диалектический/исторический материализм) — заявленная методология работы;");
    L.push("  она честно помечается в текстах, а не выдаётся за «нейтральную науку».");
    return L.join("\n");
  }

  return { buildResearchBrief: buildResearchBrief };
});
