/* test_proxy.mjs — тест прокси с мок-апстримом: маршрутизация, подстановка ключа,
   whitelist моделей, лимит тела, rate-limit, дневной лимит, таймаут апстрима. */
import { createRequire } from "module";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function ok(c, m){ if(c){pass++;} else {fail++; console.log("  FAIL:", m);} }

// --- мок-апстрим: фиксирует авторизацию и отвечает фиксированным JSON
let upstreamSeen = null;
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    upstreamSeen = { auth: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ответ модели" } }] }));
  });
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

// --- прокси в этом же процессе (env читается при require)
process.env.UPSTREAM_URL = "http://127.0.0.1:" + upPort + "/v1";
process.env.UPSTREAM_KEY = "sk-test-key";
process.env.ALLOW_MODELS = "gpt-4o-mini,custom-model";
const proxy = require("../backend/proxy.js");
await new Promise(r => proxy.server.listen(0, "127.0.0.1", r));
const port = proxy.server.address().port;
const URL_API = "http://127.0.0.1:" + port + "/api/chat";

async function post(body) {
  const res = await fetch(URL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* пусто */ }
  return { status: res.status, json };
}

// 1) чужой путь и метод → 404
let r1 = await fetch("http://127.0.0.1:" + port + "/api/other", { method: "POST" });
ok(r1.status === 404, "404 на неизвестный путь");
r1 = await fetch(URL_API, { method: "GET" });
ok(r1.status === 404, "404 на GET");

// 2) счастливый путь: ключ подставлен, модель и сообщения прошли, ответ прокинут
let r = await post({ model: "gpt-4o-mini", messages: [{ role: "user", content: "привет" }] });
ok(r.status === 200 && r.json.choices[0].message.content === "ответ модели", "200 и ответ прокинут");
ok(upstreamSeen.auth === "Bearer sk-test-key", "ключ подставлен сервером");
ok(upstreamSeen.body.model === "gpt-4o-mini" && upstreamSeen.body.messages.length === 1, "тело передано апстриму");
ok(!JSON.stringify(r.json).includes("sk-test-key"), "ключ не утёк в ответ");

// 3) модель по умолчанию, если не указана
await post({ messages: [] });
ok(upstreamSeen.body.model === "gpt-4o-mini", "модель по умолчанию");

// 4) запрещённая модель → 403 со списком разрешённых
r = await post({ model: "gpt-4-turbo-expensive", messages: [] });
ok(r.status === 403 && Array.isArray(r.json.allowed), "403 модель не из whitelist");

// 5) битый JSON → 400
r = await post("{не json");
ok(r.status === 400, "400 битый json");

// 6) огромное тело → 413
r = await post(JSON.stringify({ messages: [], pad: "x".repeat(3e6) }));
ok(r.status === 413, "413 oversized body");

// 7) rate limit в минуту: после N запросов — 429
proxy._reset();
proxy.limits.perMin = 3; proxy.limits.perHour = 1000; proxy.limits.daily = 1000;
let statuses = [];
for (let i = 0; i < 5; i++) {
  const res = await post({ model: "gpt-4o-mini", messages: [] });
  statuses.push(res.status);
}
ok(statuses.slice(0, 3).every(s => s === 200), "первые 3 запроса прошли: " + statuses.join(","));
ok(statuses[3] === 429 && statuses[4] === 429, "далее 429: " + statuses.join(","));

// 8) дневной лимит: независим от минутного
proxy._reset();
proxy.limits.perMin = 1000; proxy.limits.perHour = 1000; proxy.limits.daily = 2;
statuses = [];
for (let i = 0; i < 4; i++) {
  const res = await post({ model: "gpt-4o-mini", messages: [] });
  statuses.push(res.status);
}
ok(statuses[0] === 200 && statuses[1] === 200, "первые 2 запроса дня прошли: " + statuses.join(","));
ok(statuses[2] === 429 && statuses[3] === 429, "дневной лимит 429: " + statuses.join(","));

// 9) таймаут апстрима: отдельный процесс прокси против «зависшего» апстрима → 504
const proxyPath = fileURLToPath(new URL("../backend/proxy.js", import.meta.url));
const childScript = `
const http = require("node:http");
const slow = http.createServer((req, res) => { /* никогда не отвечаем */ });
slow.listen(0, "127.0.0.1", () => {
  process.env.UPSTREAM_URL = "http://127.0.0.1:" + slow.address().port + "/v1";
  process.env.UPSTREAM_KEY = "k";
  process.env.UPSTREAM_TIMEOUT_MS = "150";
  const proxy = require(${JSON.stringify(proxyPath)});
  proxy.server.listen(0, "127.0.0.1", () => {
    fetch("http://127.0.0.1:" + proxy.server.address().port + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] })
    }).then(res => { console.log("STATUS:" + res.status); process.exit(0); })
      .catch(e => { console.log("ERR:" + e.message); process.exit(1); });
  });
});
`;
const child = spawnSync(process.execPath, ["-e", childScript], { encoding: "utf8", timeout: 15000 });
ok((child.stdout || "").includes("STATUS:504"), "504 при зависшем апстриме (stdout: " + (child.stdout || child.stderr || "").trim().slice(0, 200) + ")");

console.log("\n==== PROXY RESULT: pass=" + pass + " fail=" + fail + " ====");
proxy.server.close();
upstream.close();
process.exit(fail ? 1 : 0);
