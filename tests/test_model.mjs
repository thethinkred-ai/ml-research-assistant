/* test_model.mjs — тест реестра утверждений/источников и научного линтера (рецензия V1.2). */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("../frontend/research-model.js");

let pass = 0, fail = 0;
function ok(c, m){ if(c){pass++;} else {fail++; console.log("  FAIL:", m);} }

// 1) добавление утверждений: сквозные ID CLM-001…
const m0 = M.emptyModel();
ok(M.addClaim(m0, { text: "x", type: "мусор" }).type === "theoretical", "неизвестный тип → theoretical");
ok(M.addClaim(m0, { text: "y", status: "мусор" }).status === "unverified", "неизвестный статус → unverified");

const m = M.emptyModel();
const c1 = M.addClaim(m, { text: "ИИ повышает производительность труда", type: "empirical" });
const c2 = M.addClaim(m, { text: "ИИ является причиной роста относительной прибавочной стоимости", type: "causal" });
ok(c1 && c1.id === "CLM-001", "первый claim = CLM-001");
ok(c2 && c2.id === "CLM-002", "второй claim = CLM-002");
ok(M.addClaim(m, { text: "   " }) === null, "пустой текст не добавляется");

// 2) источники и связка claim → source
const s1 = M.addSource(m, { title: "ILO report", author: "ILO", year: "2026", doi: "10.1234/ilo" });
const s2 = M.addSource(m, { title: "Книга без резолва", author: "Иванов" });
ok(s1 && s1.id === "SRC-001" && s2 && s2.id === "SRC-002", "сквозные ID источников");
ok(M.sourceResolved(s1) && !M.sourceResolved(s2), "резолвимость по DOI/URL");
ok(M.link(m, c1.id, s1.id) === true, "связка claim→source");
ok(M.link(m, c1.id, "SRC-999") === false, "связка с несуществующим источником запрещена");
ok(M.link(m, "CLM-999", s1.id) === false, "связка к несуществующему claim запрещена");

// 3) линтер: покрытие, типы, проблемные категории
const a = M.audit(m);
ok(a.total === 2 && a.withSource === 1 && a.withoutSource === 1, "аудит: 2 утверждения, 1 с источником");
ok(a.coverage === 50, "покрытие 50%");
ok(a.unbackedCausal.length === 1 && a.unbackedCausal[0].id === c2.id, "причинное без источника помечено");
ok(a.unbackedQuant.length === 0, "количественных нет");
ok(a.unresolvedSources.length === 1 && a.unresolvedSources[0].id === s2.id, "нерезолвленный источник помечен");
ok(a.byType.causal.total === 1 && a.byType.causal.backed === 0, "разбивка по типам");

// 4) backed через evidence даже без источника (статус + доказательство)
M.updateClaim(m, c2.id, { status: "partial", evidence: "логический разбор механизма в гл. 2" });
const a2 = M.audit(m);
ok(a2.withSource === 2 && a2.unbackedCausal.length === 0, "evidence+статус закрывает утверждение");

// 5) updateClaim и удаление
M.updateClaim(m, c1.id, { status: "supported" });
ok(m.claims[0].status === "supported" && m.claims[0].id === "CLM-001", "update сохраняет ID");
M.removeSource(m, s1.id);
ok(m.claims[0].sourceIds.length === 0, "удаление источника чистит связи");
M.removeClaim(m, c1.id);
ok(m.claims.length === 1, "удаление claim");

// 6) все 8 типов и статусы присутствуют
ok(Object.keys(M.CLAIM_TYPES).length === 8, "8 типов утверждений");
["definition","textual","historical","empirical","quantitative","causal","theoretical","normative"]
  .forEach(t => ok(!!M.CLAIM_TYPES[t].label, "тип " + t + " с меткой"));
ok(Object.keys(M.STATUSES).length === 5, "5 статусов");

// 7) completeness — считается по фактам
const mFull = M.emptyModel();
["a", "b", "c"].forEach(t => { const c = M.addClaim(mFull, { text: t }); M.link(mFull, c.id, M.addSource(mFull, { title: "s" + t, url: "https://x" }).id); });
const done = M.completeness(mFull, { topicReady: true, hasEmpirical: true, hypothesisReady: true,
  noveltyReady: true, questionsReady: true, draftRatio: 0.9 });
const none = M.completeness(M.emptyModel(), { topicReady: false, hasEmpirical: true, hypothesisReady: false,
  noveltyReady: false, questionsReady: false, draftRatio: 0 });
ok(done.percent > none.percent, "готовность растёт с выполненными пунктами");
ok(done.percent === 100 && none.percent < 40, "границы процентов (" + done.percent + "/" + none.percent + ")");
ok(done.items.length >= 8, "пунктов готовности ≥ 8");

// 8) markdown реестра
const m2 = M.emptyModel();
M.addClaim(m2, { text: "Доля труда | в ВВП растёт", type: "quantitative" });
M.addSource(m2, { title: "Stat", url: "https://example.com" });
const mod2 = m2; M.link(mod2, "CLM-001", "SRC-001");
const md = M.toMarkdown(mod2);
ok(md.includes("CLM-001") && md.includes("количественное"), "md: id и тип");
ok(md.includes("Доля труда \\| в ВВП"), "md: экранирование пайпов");
ok(md.includes("SRC-001") && md.includes("не резолвится") === false, "md: источник резолвится");
ok(M.toMarkdown(M.emptyModel()) === "", "пустая модель → пустой markdown");

// 9) сериализация
const ser = M.serialize(m2);
const back = M.deserialize(ser);
ok(back.claims.length === 1 && back.sources.length === 1, "round-trip");
ok(M.deserialize("мусор").claims.length === 0, "битый JSON → пустая модель");
ok(M.deserialize('{"claims":1}').claims.length === 0, "неверная форма → пустая модель");

console.log("\n==== MODEL RESULT: pass=" + pass + " fail=" + fail + " ====");
process.exit(fail?1:0);
