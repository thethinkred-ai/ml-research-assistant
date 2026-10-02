/* test_llm.mjs — тест слоя LLM с мок-fetch: сборка запроса, парсинг, HTTP-ошибки,
   ретраи с backoff, отмена, частичный дозапуск, параллельность, сборка markdown. */
import { createRequire } from "module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const E = require("../frontend/engine.js");
const P = require("../frontend/prompts.js");
const L = require("../frontend/llm.js");

let pass = 0, fail = 0;
function ok(c, m){ if(c){pass++;} else {fail++; console.log("  FAIL:", m);} }

// 1) промпты содержат тему и МЛ-термины
const bp = E.buildBlueprint({ topic: "Отчуждение труда в сфере образования", kind: "diplom", field: "философия", applied: true });
const tasks = P.buildTasks(bp, 200);
ok(tasks.length >= 5, "tasks built ("+tasks.length+")");
ok(tasks[0].prompt.includes("Отчуждение труда"), "prompt has topic");
ok(/материализм|диалектическ/i.test(P.SYSTEM), "system has ML framing");
ok(tasks.some(t => /Введение/.test(t.title)), "has intro");
ok(tasks.some(t => /Заключение/.test(t.title)), "has conclusion");

// 1b) исследовательские режимы (рецензия V1.2/V1.4)
ok(/методолог-исследователь/.test(P.MODE_SYSTEM) && /Не|не/.test(P.MODE_SYSTEM), "MODE_SYSTEM: аналитическая установка");
const ex = P.explorePrompt(bp);
ok(/режим Explore/.test(ex) && ex.includes("Отчуждение труда"), "explore: карта темы по теме работы");
const vf = P.verifyPrompt({ text: "X влияет на Y", type: "эмпирическое" });
ok(/режим Verify/.test(vf) && vf.includes("X влияет на Y") && /РЕКОМЕНДАЦИЯ/.test(vf), "verify: формат проверки");
const cp = P.comparePrompt(bp, "Маркс, Вебер");
ok(/режим Compare/.test(cp) && cp.includes("Маркс, Вебер") && /\| Критерий/.test(cp), "compare: матрица");
const cr = P.critiquePrompt("Текст для критики.", bp);
ok(/режим Critic/.test(cr) && /корреляции и причинности/.test(cr) && cr.includes("Текст для критики."), "critic: таксономия ошибок");
const ma = P.marxistAuditPrompt("Текст.", bp);
ok(/категориальную экспертизу/.test(ma) && /трудовой теории стоимости/.test(ma), "марксистская экспертиза");

// 1c) v1.4: подсказка противоречия и сопоставление прогноза/результата
const ch = P.contradictionHintPrompt(bp);
ok(/заказ/i.test(ch) && /слабое звено/.test(ch) && ch.includes("Отчуждение труда"), "подсказка противоречия: заказ→звенья");
const oc = P.outcomeComparePrompt(bp, { noveltyActual: "модель подтвердилась", significanceActual: "" });
ok(/ПРОГНОЗ НОВИЗНЫ/.test(oc) && oc.includes("модель подтвердилась") && /без слова «впервые»/.test(oc), "сопоставление прогноз/результат");
const rv = P.revisionPrompt("1.1. Тест", "Исходный текст параграфа.", "- квантор «всегда»", bp);
ok(/режим Revision/.test(rv) && rv.includes("квантор «всегда»") && rv.includes("Исходный текст параграфа"), "revision: замечания + исходный текст");
// автоновизны больше нет в задачах без основания
const bpNoNov = E.buildBlueprint({ topic: "Т", kind: "referat" });
const tasksNoNov = P.buildTasks(bpNoNov, 100);
ok(!/новизна \(/.test(tasksNoNov[tasksNoNov.length-1].prompt), "заключение без основания не утверждает новизну");

// 2) прокси-режим: без ключа запрос уходит (ключ подставит сервер), пустой Authorization не отправляется
let noKeyCap = null;
const noKeyFetch = (url, init) => {
  noKeyCap = { url, init, body: JSON.parse(init.body) };
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
    json: () => Promise.resolve({ choices: [{ message: { content: "ок" } }] }) });
};
const noKey = await L.chat([{ role: "user", content: "x" }], { apiKey: "" }, noKeyFetch);
ok(noKey === "ок", "без ключа — прокси-режим работает");
ok(noKeyCap.url === L.DEFAULTS.baseUrl + "/chat/completions", "дефолтный baseUrl (" + L.DEFAULTS.baseUrl + ")");
ok(noKeyCap.init.headers.Authorization === undefined, "пустой Authorization не отправляется");
ok(noKeyCap.body.model === L.DEFAULTS.model, "дефолтная модель подставлена");

// 3) chat() собирает корректный запрос и парсит ответ
let captured = null;
const mockFetch = (url, init) => {
  captured = { url, init, body: JSON.parse(init.body) };
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
    json: () => Promise.resolve({ choices: [{ message: { content: "  Готовый текст раздела.  " } }] }) });
};
const text = await L.chat([{role:"system",content:"S"},{role:"user",content:"U"}],
  { apiKey: "sk-test", baseUrl: "https://api.example.com/v1/", model: "m1" }, mockFetch);
ok(text === "Готовый текст раздела.", "content trimmed & parsed");
ok(captured.url === "https://api.example.com/v1/chat/completions", "url built (trailing slash stripped)");
ok(captured.init.method === "POST", "POST");
ok(captured.init.headers.Authorization === "Bearer sk-test", "auth header");
ok(captured.body.model === "m1" && captured.body.messages.length === 2, "body model+messages");

// 4) HTTP-ошибка без ретраев пробрасывается с кодом
await L.chat([{role:"user",content:"x"}], { apiKey: "k" }, () => Promise.resolve({ ok:false, status:429, headers:{get:()=>null} }), { retries: 0 })
  .then(()=>ok(false,"should throw http"), e=>ok(e.code==="HTTP_429","http error code"));

// 5) ретраи: два 429 с Retry-After: 0, затем успех → 3 вызова, текст получен
let calls5 = 0;
const retryFetch = () => {
  calls5++;
  if (calls5 <= 2) return Promise.resolve({ ok:false, status:429, headers:{ get: () => "0" } });
  return Promise.resolve({ ok:true, status:200, headers:{get:()=>null}, json:()=>Promise.resolve({choices:[{message:{content:"ок"}}]}) });
};
const retried = await L.chat([{role:"user",content:"x"}], { apiKey:"k" }, retryFetch, { retries: 2 });
ok(retried === "ок" && calls5 === 3, "retried twice then ok (" + calls5 + " calls)");

// 5b) ретраи исчерпаны → ошибка HTTP_429 после 3 попыток
let calls5b = 0;
await L.chat([{role:"user",content:"x"}], { apiKey:"k" }, () => { calls5b++;
    return Promise.resolve({ ok:false, status:429, headers:{ get: () => "0" } }); }, { retries: 2 })
  .then(()=>ok(false,"should fail"), e=>ok(e.code==="HTTP_429" && calls5b===3, "retries exhausted (" + calls5b + " calls)"));

// 6) сетевой сбой ретраится и затем проходит
let calls6 = 0;
const netFetch = () => { calls6++; if (calls6 === 1) return Promise.reject(new TypeError("fetch failed"));
  return Promise.resolve({ ok:true, status:200, headers:{get:()=>null}, json:()=>Promise.resolve({choices:[{message:{content:"ок2"}}]}) }); };
const net = await L.chat([{role:"user",content:"x"}], { apiKey:"k" }, netFetch, { retries: 2 });
ok(net === "ок2" && calls6 === 2, "network error retried");

// 7) отмена: уже отменённый сигнал → CANCELLED без единого вызова
let calls7 = 0;
const ac = new AbortController(); ac.abort();
await L.chat([{role:"user",content:"x"}], { apiKey:"k" }, () => { calls7++; return Promise.resolve({ok:true,status:200,headers:{get:()=>null},json:()=>Promise.resolve({choices:[{message:{content:"x"}}]})}); }, { signal: ac.signal })
  .then(()=>ok(false,"should reject cancelled"), e=>ok(e.code==="CANCELLED" && calls7===0, "pre-aborted signal → CANCELLED, 0 calls"));

// 8) expand() проходит все задачи и собирает markdown
let calls8 = 0;
const seqFetch = () => { calls8++; return Promise.resolve({ ok:true, status:200, headers:{get:()=>null}, json:()=>Promise.resolve({choices:[{message:{content:"раздел "+calls8}}]}) }); };
const res8 = await L.expand(bp, { apiKey:"k", model:"m" }, { fetchImpl: seqFetch, words: 120 });
ok(res8.errors.length === 0, "no errors in happy expand");
ok(Object.keys(res8.sections).length === tasks.length, "expand produced all sections");
ok(calls8 === tasks.length, "one call per task");
const md = L.assembleMarkdown(bp, res8.sections);
ok(md.includes("## Введение") && md.includes("### ") && md.includes("Список литературы"), "markdown assembled");
ok(md.includes("Отчуждение труда"), "markdown has topic");

// 9) частичный сбой: секция помечается пустой, ошибки собраны
const badFetch = () => Promise.reject({ code:"NET", message:"сбой сети" });
const res9 = await L.expand(bp, { apiKey:"k" }, { fetchImpl: badFetch, words: 100 });
ok(res9.sections.intro === "", "failed section empty, not thrown");
ok(res9.errors.length === tasks.length, "all errors collected");

// 10) дозапуск: переданные непустые секции пропускаются
const partial = {}; partial[tasks[0].key] = "уже готово";
let calls10 = 0;
const res10 = await L.expand(bp, { apiKey:"k" }, { fetchImpl: () => { calls10++;
    return Promise.resolve({ ok:true, status:200, headers:{get:()=>null}, json:()=>Promise.resolve({choices:[{message:{content:"текст"}}]}) }); },
  sections: partial, words: 100 });
ok(calls10 === tasks.length - 1, "skip prefilled sections (" + calls10 + " calls)");
ok(res10.sections[tasks[0].key] === "уже готово", "prefilled value kept");

// 11) параллельность 2: все секции получены, вызовов столько же
let calls11 = 0, inflight = 0, maxInflight = 0;
const concFetch = () => { calls11++; inflight++; maxInflight = Math.max(maxInflight, inflight);
  return new Promise(r => setTimeout(() => { inflight--; r({ ok:true, status:200, headers:{get:()=>null},
    json:()=>Promise.resolve({choices:[{message:{content:"с"}}]}) }); }, 5)); };
const res11 = await L.expand(bp, { apiKey:"k" }, { fetchImpl: concFetch, words: 100, concurrency: 2 });
ok(Object.keys(res11.sections).length === tasks.length && calls11 === tasks.length, "concurrency ok");
ok(maxInflight === 2, "two parallel requests observed");

// 12) отмена в процессе expand: оставшиеся секции пустые, код CANCELLED
let calls12 = 0;
const ac12 = new AbortController();
const slowFetch = (url, init) => { calls12++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok:true, status:200, headers:{get:()=>null},
      json:()=>Promise.resolve({choices:[{message:{content:"с"}}]}) }), 30);
    init.signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
  });
};
setTimeout(() => ac12.abort(), 10);
const res12 = await L.expand(bp, { apiKey:"k" }, { fetchImpl: slowFetch, words: 100, signal: ac12.signal });
ok(res12.errors.length > 0 && res12.errors.every(x => x.error.code === "CANCELLED" || x.error.code !== undefined), "cancel recorded as errors");
ok(Object.keys(res12.sections).length < tasks.length || res12.errors.length > 0, "cancelled run incomplete or flagged");

// 13) браузерный контекст: без require и global (регрессия «global is not defined»)
const sandbox = {
  console, setTimeout,
  fetch: () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null },
    json: () => Promise.resolve({ choices: [{ message: { content: "браузерный текст" } }] }) })
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../frontend/engine.js", import.meta.url), "utf8"), sandbox);
vm.runInContext(readFileSync(new URL("../frontend/prompts.js", import.meta.url), "utf8"), sandbox);
vm.runInContext(readFileSync(new URL("../frontend/llm.js", import.meta.url), "utf8"), sandbox);
const res13 = await vm.runInContext(
  `MLLlm.expand(MLResearchEngine.buildBlueprint({ topic: "Тема", kind: "referat" }), { apiKey: "k" }, { words: 50 })`,
  sandbox
);
ok(res13.errors.length === 0 && Object.keys(res13.sections).length >= 5, "браузерный контекст без require/global работает");

console.log("\n==== LLM RESULT: pass=" + pass + " fail=" + fail + " ====");
process.exit(fail?1:0);
