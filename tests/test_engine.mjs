/* test_engine.mjs — юнит-тест методического движка */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const E = require("../frontend/engine.js");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  FAIL:", msg); } }

const cases = [
  { topic: "Формирование критического мышления у старшеклассников", kind: "kursovaya", field: "педагогика", hasEmpirical: true, applied: true },
  { topic: "Прибавочная стоимость в условиях цифрового капитала", kind: "referat", field: "политическая экономия" },
  { topic: "Отчуждение труда в сфере образования", kind: "diplom", field: "философия образования", applied: true },
  {} // пустой вход — проверка устойчивости
];

for (const c of cases) {
  const bp = E.buildBlueprint(c);
  const md = E.toMarkdown(bp);
  console.log("\n=== case:", c.topic || "(пусто)", "| kind:", c.kind || "referat", "| md len:", md.length);

  // обязательные непустые блоки
  ok(bp.actualnost.length > 40, "actualnost");
  ok(bp.problem.length > 30, "problem");
  ok(bp.object && bp.subject, "object/subject");
  ok(bp.goal.length > 30, "goal");
  ok(Array.isArray(bp.tasks) && bp.tasks.length >= 3, "tasks>=3");
  ok(Array.isArray(bp.methods.theoretical) && bp.methods.theoretical.length >= 4, "methods theor");
  ok(Array.isArray(bp.stages) && bp.stages.length >= 3, "stages");
  ok(bp.structure.chapters.length >= 2, "chapters>=2");
  ok(bp.intro.includes("ВВЕДЕНИЕ"), "intro has ВВЕДЕНИЕ");
  ok(bp.literature.some(l => /Маркс/.test(l)) && bp.literature.some(l => /Ленин/.test(l)), "ML классики в списке");
  ok(bp.literatureLinks.length === 3 && bp.literatureLinks.every(l => /^https:/.test(l.url)), "ссылки на подбор литературы");

  // МЛ-методология присутствует в тексте
  ok(/диалектическ/i.test(md) && /материализ/i.test(md), "ML framing present");
  ok(/противореч/i.test(md), "contradiction framing");

  // задачи не дублируют цель и не шире её (по книге) — грубая проверка: ни одна задача == цель
  ok(bp.tasks.every(t => t.trim() !== bp.goal.trim()), "task != goal");

  // тема подставлена в каркас
  if (c.topic) ok(md.includes(c.topic), "topic substituted");

  // для диплома есть 3 главы + методическая; для реферата — нет эмпирической главы
  if (c.kind === "diplom") ok(bp.structure.chapters.length === 3 && /Методические/.test(md), "diplom 3 chapters");
  if (c.kind === "referat") ok(!/Эмпирическое исследование/.test(md), "referat no empirical chapter");
  if (c.kind === "kursovaya" && c.hasEmpirical) ok(bp.hypothesis.length > 30, "kursovaya hypothesis");
}

// пустой вход не роняет движок
const empty = E.buildBlueprint({});
ok(E.toMarkdown(empty).length > 200, "empty input safe");

// --- детерминизм: одинаковый вход → одинаковый каркас
const d1 = E.buildBlueprint({ topic: "Государство и революция в теоретическом наследии", kind: "kursovaya" });
const d2 = E.buildBlueprint({ topic: "Государство и революция в теоретическом наследии", kind: "kursovaya" });
ok(E.toMarkdown(d1) === E.toMarkdown(d2), "детерминизм: одинаковый вход → одинаковый md");

// --- вариативность: разные темы дают разные формулировки хотя бы в одном блоке
const t1 = E.buildBlueprint({ topic: "Товарный фетишизм", kind: "kursovaya" });
const t2 = E.buildBlueprint({ topic: "Классовая борьба в современном городе", kind: "kursovaya" });
const blocks = ["actualnost", "contradiction", "problem", "goal", "novelty"];
ok(blocks.some(b => t1[b] !== t2[b]), "вариативность формулировок между темами");

// --- пресеты дисциплин
const econ = E.buildBlueprint({ topic: "Роль финансового капитала", field: "экономика" });
const phil = E.buildBlueprint({ topic: "Роль финансового капитала", field: "философия" });
ok(econ.preset === "экономика" && /производственные отношения/.test(econ.object), "пресет экономика в объекте");
ok(phil.preset === "философия" && /категориальный аппарат/.test(phil.object), "пресет философия в объекте");
ok(econ.significance !== phil.significance, "значимость различается по пресету");

// --- пользовательские источники попадают в список литературы
const withSrc = E.buildBlueprint({ topic: "Тест", sources: "Иванов И. И. Книга. — М., 2020.\n\nПетров П. П. Статья. — 2021." });
ok(withSrc.literature.some(l => l.includes("Иванов И. И.")) && withSrc.literature.some(l => l.includes("Петров П. П.")), "свои источники добавлены");
ok(!withSrc.literature.some(l => l.includes("[Источник по теме")), "плейсхолдеры убраны при своих источниках");

// --- бюджет слов для LLM
ok(E.suggestWords(d1) >= 120 && E.suggestWords(d1) <= 500, "suggestWords в границах");
const dip = E.buildBlueprint({ topic: "Т", kind: "diplom", volumePages: 60 });
const ref = E.buildBlueprint({ topic: "Т", kind: "referat", volumePages: 15 });
ok(E.suggestWords(dip) >= E.suggestWords(ref), "бюджет слов растёт с объёмом работы");

// --- шаблон заключения
const concl = E.buildBlueprint({ topic: "Отчуждение труда", kind: "kursovaya", hasEmpirical: true });
ok(concl.concl.includes("ЗАКЛЮЧЕНИЕ"), "заключение: заголовок");
ok(concl.concl.includes("Итоги по поставленным задачам:"), "заключение: итоги по задачам");
ok((concl.concl.match(/\d\) По задаче/g) || []).length === concl.tasks.length, "заключение: строка итогов на каждую задачу");
ok(concl.concl.includes("Гипотеза исследования [подтверждена"), "заключение: гипотеза для эмпирики");
ok(concl.concl.includes("Перспективы"), "заключение: перспективы");
ok(E.toMarkdown(concl).includes("## Шаблон Заключения"), "md содержит шаблон заключения");
const conclTheory = E.buildBlueprint({ topic: "Тема теоретическая", kind: "referat", hasEmpirical: false });
ok(!conclTheory.concl.includes("Гипотеза исследования"), "заключение: без гипотезы для реферата без эмпирики");

// --- проверка темы на широту/перегруженность
const wide = E.buildBlueprint({ topic: "Отчуждение", kind: "referat", volumePages: 15 });
ok(wide.topicCheck.verdict === "wide" && wide.topicCheck.suggestions.length >= 2, "тема из 1 слова — широкая, есть подсказки");
ok(E.toMarkdown(wide).includes("Проверка темы"), "md содержит предупреждение о широкой теме");
const narrow = E.buildBlueprint({ topic: "Влияние цифровизации сферы образования на процессы отчуждения труда учителей в условиях периферийного региона", kind: "referat" });
ok(narrow.topicCheck.verdict === "narrow", "тема из 10+ слов — перегруженная");
const fine = E.buildBlueprint({ topic: "Отчуждение труда в сфере образования", kind: "referat" });
ok(fine.topicCheck.verdict === "ok", "нормальная тема — ok");
ok(!E.toMarkdown(fine).includes("Проверка темы"), "md без предупреждения для нормальной темы");
const emptyChk = E.analyzeTopic({ topic: "«[укажите тему]»", volumePages: 15, field: "x" });
ok(emptyChk.verdict === "empty", "пустая тема — empty");

// --- глоссарий
ok(Array.isArray(E.GLOSSARY) && E.GLOSSARY.length >= 15, "глоссарий: не меньше 15 терминов");
ok(E.GLOSSARY.some(g => /Объект исследования/.test(g.term)) && E.GLOSSARY.some(g => /Предмет/.test(g.term)), "глоссарий: ключевые термины");
ok(E.GLOSSARY.every(g => g.def.length > 30), "глоссарий: все определения содержательны");

// --- V1.2: гипотеза-конструктор вместо универсальной (рецензия п. 9)
const hyp = E.buildBlueprint({ topic: "Влияние X на Y", kind: "kursovaya", hasEmpirical: true });
ok(!/рассматривать как противоречивый процесс/.test(hyp.hypothesis), "гипотеза: универсальная формулировка удалена");
ok(hyp.hypothesis.includes("[X") && hyp.meta.hypX === "", "гипотеза: каркас с плейсхолдерами, части пусты");
ok(hyp.hypothesisReady === false, "гипотеза не собрана без частей");
const hypFull = E.buildBlueprint({ topic: "Влияние X на Y", kind: "kursovaya", hasEmpirical: true,
  hypX: "внедрение тренажёра", hypY: "скорость обучения растёт", hypM: "снижение когнитивной нагрузки", hypC: "равные группы" });
ok(/^Если внедрение тренажёра, то скорость обучения растёт, поскольку снижение/.test(hypFull.hypothesis), "гипотеза: Если X, то Y, поскольку M");
ok(hypFull.hypothesisReady === true, "гипотеза собрана");

// --- V1.2: новизна — чеклист + основание, никаких «впервые…» (рецензия п. 8)
ok(!/впервые.*систематически раскрыт/.test(E.toMarkdown(hyp)), "новизна: автоутверждение «впервые…» удалено");
ok(hyp.novelty.includes("Новизна не заявляется автоматически") && hyp.novelty.includes("новое понятие"), "новизна: чеклист типов");
ok(!hyp.noveltyReady, "новизна без основания не готова");
const novFull = E.buildBlueprint({ topic: "Влияние X на Y", kind: "kursovaya",
  noveltyTypes: ["explanation", "model"], noveltyBasis: "отличие от Иванова 2020 в механизме" });
ok(novFull.novelty.includes("новое объяснение") && novFull.novelty.includes("Иванова 2020"), "новизна: типы и основание подставлены");
ok(novFull.noveltyReady, "новизна с основанием готова");
ok(Object.keys(E.NOVELTY_TYPES).length === 6, "6 типов новизны");

// --- V1.2: неизвестная дисциплина → общий профиль, не педагогика (рецензия п. 13)
const unknown = E.buildBlueprint({ topic: "Прагматика заголовков в СМИ", field: "лингвистика" });
ok(unknown.preset === "общая", "неизвестная дисциплина → общий профиль");
const nofield = E.buildBlueprint({ topic: "Некая тема без области", field: "" });
ok(nofield.preset === "общая" && !/педагогика/.test(nofield.object), "пустое поле → общий профиль без педагогики");
ok(!/\s\s/.test(nofield.subject), "пустое поле не ломает формулировки (двойных пробелов нет)");
const ped = E.buildBlueprint({ topic: "Тема", field: "педагогика" });
ok(ped.methods.theoretical.some(t => /педагогическое наблюдение/.test(t)), "профиль педагогики добавляет методы");
const hist = E.buildBlueprint({ topic: "Тема", field: "история" });
ok(hist.methods.theoretical.some(t => /источниковедческая критика/.test(t)), "профиль истории: источниковедческая критика");

// --- V1.3: тип исследования отделён от формата работы (рецензия п. 14)
ok(E.buildBlueprint({ topic: "Т", kind: "referat" }).researchTypeLabel === "обзор литературы", "реферат → обзор литературы по умолчанию");
const cmp = E.buildBlueprint({ topic: "Т", kind: "diplom", researchType: "comparative" });
ok(cmp.researchTypeLabel === "сравнительное", "тип исследования переопределяется");

// --- V1.3: исследовательские вопросы до аппарата (рецензия п. 1–2)
ok(hyp.questions.length >= 3 && hyp.questions.every(q => q.includes("?")), "вопросы-черновики сгенерированы");
ok(E.toMarkdown(hyp).includes("Исследовательские вопросы"), "вопросы в markdown");

console.log("\n==== RESULT: pass=" + pass + " fail=" + fail + " ====");
process.exit(fail ? 1 : 0);
