/* server/proxy.js — OpenAI-совместимый прокси, чтобы не светить ключ в браузере.
   Защита бюджета: rate-limit по IP (минута/час), дневной лимит запросов, whitelist моделей,
   лимит размера тела, таймаут апстрима, логи.

   Запуск:
     UPSTREAM_KEY=sk-... \
     UPSTREAM_URL=https://api.openai.com/v1 \
     ALLOW_ORIGIN=https://ваш-домен \
     ALLOW_MODELS=gpt-4o-mini,gpt-4o \
     RATE_PER_MIN=6 RATE_PER_HOUR=40 DAILY_LIMIT=300 \
     PORT=8787 node server/proxy.js

   Браузер шлёт запросы на http://<ваш-хост>:8787/api  (в UI Base URL = /api или https://ваш-домен/api).
   Для прода всё равно рекомендуется HTTPS (за nginx/Caddy) и, при необходимости, авторизация пользователей. */
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0"; // за nginx ставьте HOST=127.0.0.1
const UPSTREAM = (process.env.UPSTREAM_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const KEY = process.env.UPSTREAM_KEY || "";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const MODELS = (process.env.ALLOW_MODELS || "gpt-4o-mini,gpt-4o,gpt-4.1-mini,gpt-4.1")
  .split(",").map(s => s.trim()).filter(Boolean);
const BODY_LIMIT = +(process.env.BODY_LIMIT || 2e6);
const UPSTREAM_TIMEOUT_MS = +(process.env.UPSTREAM_TIMEOUT_MS || 120000);

// Лимиты вынесены в объект, чтобы тесты могли их менять; значения по умолчанию — из env.
const limits = {
  perMin: +(process.env.RATE_PER_MIN || 6),
  perHour: +(process.env.RATE_PER_HOUR || 40),
  daily: +(process.env.DAILY_LIMIT || 300)
};

const hits = new Map(); // ip -> { min: [ts], hour: [ts] }
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function _reset() { // тестовый хук
  hits.clear(); dayCount = 0; dayKey = new Date().toISOString().slice(0, 10);
}

function overLimit(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h) { h = { min: [], hour: [] }; hits.set(ip, h); }
  h.min = h.min.filter(t => now - t < 60e3);
  h.hour = h.hour.filter(t => now - t < 3600e3);
  if (h.min.length >= limits.perMin) return "rate per minute";
  if (h.hour.length >= limits.perHour) return "rate per hour";
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= limits.daily) return "daily limit";
  h.min.push(now); h.hour.push(now); dayCount++;
  return null;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function send(res, req, log, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}));
  log(code);
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const ip = (req.socket.remoteAddress || "?").replace(/^::ffff:/, "");
  const log = (code, extra) => console.log(
    [new Date().toISOString(), ip, req.method, req.url, code, (Date.now() - t0) + "ms", extra || ""].join(" ")
  );

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); return res.end(); }
  cors(res);

  if (req.method !== "POST" || !req.url.startsWith("/api/chat")) {
    return send(res, req, log, 404, { error: "not found" });
  }
  if (!KEY) {
    return send(res, req, log, 500, { error: "UPSTREAM_KEY не задан на сервере" }, { "Retry-After": "0" });
  }

  const len = +req.headers["content-length"] || 0;
  if (len > BODY_LIMIT) {
    return send(res, req, log, 413, { error: "request body too large" });
  }

  const limited = overLimit(ip);
  if (limited) {
    return send(res, req, log, 429, { error: "too many requests: " + limited }, { "Retry-After": "60" });
  }

  let body = "";
  let answered = false;
  req.on("data", c => {
    body += c;
    if (body.length > BODY_LIMIT && !answered) {
      answered = true;
      send(res, req, log, 413, { error: "request body too large" });
      req.destroy();
    }
  });
  req.on("error", () => { /* соединение оборвано — ответ уже не нужен */ });
  req.on("end", () => {
    if (answered) return;
    let payload;
    try { payload = JSON.parse(body); } catch (e) {
      return send(res, req, log, 400, { error: "bad json" });
    }
    // принимаем {messages, model, temperature}; ключ подставляет сервер
    const model = payload.model || "gpt-4o-mini";
    if (!MODELS.includes(model)) {
      return send(res, req, log, 403, { error: "model not allowed", allowed: MODELS }, { "Retry-After": "0" });
    }
    const out = JSON.stringify({
      model: model,
      temperature: payload.temperature ?? 0.6,
      messages: payload.messages || []
    });
    const target = new URL(UPSTREAM + "/chat/completions");
    // guard: невалидный ключ не должен ронять процесс (кириллица/пробелы в заголовке)
    if (!KEY || /[^!-~]/.test(KEY)) {
      send(res, req, log, 503, { error: { message: "Proxy not configured: invalid UPSTREAM_KEY" } });
      return;
    }
    const client = target.protocol === "http:" ? http : https;
    const up = client.request(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + KEY, "Content-Length": Buffer.byteLength(out) }
    }, upRes => {
      let data = "";
      upRes.on("data", d => data += d);
      upRes.on("error", () => {
        if (!res.headersSent) send(res, req, log, 502, { error: "upstream stream failed" });
        else { log(502, "upstream stream failed"); res.end(); }
      });
      upRes.on("end", () => {
        res.writeHead(upRes.statusCode, { "Content-Type": "application/json" });
        res.end(data);
        log(upRes.statusCode, model);
      });
    });
    up.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      up.destroy();
      if (!res.headersSent) send(res, req, log, 504, { error: "upstream timeout" });
    });
    up.on("error", e => {
      if (!res.headersSent) send(res, req, log, 502, { error: "upstream failed: " + e.message });
    });
    up.end(out);
  });
});

if (require.main === module) {
  if (ALLOW_ORIGIN === "*") console.warn("ВНИМАНИЕ: ALLOW_ORIGIN=* — любой сайт сможет пользоваться вашим ключом. Для продакшена задайте свой домен.");
  server.listen(PORT, HOST, () => console.log("ML proxy on http://" + HOST + ":" + PORT + "/api  ->  " + UPSTREAM +
    "  |  models: " + MODELS.join(", ") + "  |  limits: " + limits.perMin + "/min, " + limits.perHour + "/hour, " + limits.daily + "/day"));
}

module.exports = { server, overLimit, limits, _reset };
