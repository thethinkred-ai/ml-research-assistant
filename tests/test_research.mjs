/* test_research.mjs — тест брифа для OpenResearch (alphaXiv): методология, аппарат,
   команды orx, дерево экспериментов, артефакты, детерминизм. */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const E = require("../frontend/engine.js");
const P = require("../frontend/prompts.js");
const R = require("../frontend/research.js");

let pass = 0, fail = 0;
function ok(c, m){ if(c){pass++;} else {fail++; console.log("  FAIL:", m);} }

const bp = E.buildBlueprint({ topic: "Отчуждение труда в сфере образования", kind: "diplom", field: "философия образования" });
const brief = R.buildResearchBrief(bp);

// 1) самодостаточность: методология (системный промпт) встроена целиком
ok(brief.startsWith("# Исследовательский бриф:"), "бриф: заголовок");
ok(brief.includes(P.SYSTEM), "бриф: системный промпт МЛ-методологии встроен");
ok(brief.includes("OpenResearch"), "бриф: целевая среда названа");

// 2) аппарат исследования передан
ok(brief.includes("Отчуждение труда в сфере образования"), "бриф: тема");
ok(brief.includes(bp.problem) && brief.includes(bp.goal), "бриф: проблема и цель");
ok(brief.includes(bp.hypothesis), "бриф: гипотеза (диплом)");
bp.tasks.forEach(t => ok(brief.includes(t.replace(/;\s*$/, "")), "бриф: задача «" + t.slice(0, 30) + "…»"));

// 3) команды orx и правила дерева
ok(brief.includes('orx discover "Отчуждение труда в сфере образования"'), "бриф: команда discover с темой");
ok(brief.includes("orx paper <arxiv-id | doi>"), "бриф: команда paper");
ok(/promote/.test(brief) && /repair/.test(brief) && /refill/.test(brief), "бриф: ходы repair/refill/promote");
ok(/D1/.test(brief) && /D4/.test(brief), "бриф: направления пронумерованы");

// 4) литература и артефакты
ok(brief.includes("cyberleninka.ru"), "бриф: ссылки на подбор литературы");
ok(brief.includes("Глава 3. Методические рекомендации"), "бриф: структура глав (диплом = 3 главы)");
ok(brief.includes("[источник]"), "бриф: правило пометки непроверенных данных");

// 5) честность
ok(/принадлежит автору/.test(brief), "бриф: ответственность автора");
ok(/выдумывать источники запрещено/.test(brief), "бриф: запрет выдуманных источников");

// 6) детерминизм и консистентность для разных типов работ
ok(R.buildResearchBrief(bp) === brief, "бриф: детерминизм");
const refBp = E.buildBlueprint({ topic: "Тема теоретическая без эмпирики", kind: "referat" });
const refBrief = R.buildResearchBrief(refBp);
ok(refBrief.includes("теоретическая"), "бриф: реферат без гипотезы помечен как теоретический");
ok(!refBrief.includes("Глава 3."), "бриф: у реферата нет третьей главы");

console.log("\n==== RESEARCH RESULT: pass=" + pass + " fail=" + fail + " ====");
process.exit(fail?1:0);
