/* llm.js — обёртка над OpenAI-совместимым /chat/completions для развёртывания разделов.
   Работает в браузере (window.fetch) и в Node (инъекция fetchImpl).
   Возможности: ретраи с backoff для 429/5xx/сетевых сбоев (учитывается Retry-After),
   таймаут запроса и отмена через AbortSignal, частичный дозапуск упавших секций,
   настраиваемая параллельность. */
(function (global, factory) {
  var api = factory(global);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (global) global.MLLlm = api;
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function (global) {
  "use strict";

  var DEFAULTS = {
    baseUrl: "/api",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    temperature: 0.6,
    timeoutMs: 120000,   // таймаут одного HTTP-запроса
    retries: 2,          // дополнительных попыток после первой (итого до 3 запросов)
    backoffMs: 800,      // база экспоненциальной паузы между попытками
    concurrency: 1       // одновременных запросов при expand()
  };

  function normalizeCfg(cfg) {
    cfg = cfg || {};
    var base = (cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
    return {
      apiKey: cfg.apiKey || "",
      baseUrl: base,
      model: cfg.model || DEFAULTS.model,
      temperature: (cfg.temperature == null ? DEFAULTS.temperature : cfg.temperature),
      timeoutMs: cfg.timeoutMs || DEFAULTS.timeoutMs,
      retries: (cfg.retries == null ? DEFAULTS.retries : cfg.retries),
      backoffMs: cfg.backoffMs || DEFAULTS.backoffMs
    };
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function parseRetryAfter(res) {
    try {
      if (res && typeof res.headers.get === "function") {
        var v = res.headers.get("retry-after");
        if (v) {
          var sec = parseInt(v, 10);
          if (!isNaN(sec)) return Math.min(Math.max(sec, 0), 30) * 1000; // кап 30 с
        }
      }
    } catch (e) { /* заголовков может не быть */ }
    return null;
  }

  // Один вызов модели с ретраями. cfg.apiKey опционален (прокси-режим); fetchImpl — инъекция для тестов;
  // opts: { fetchImpl, signal (AbortSignal), retries, timeoutMs }.
  function chat(messages, cfg, fetchImpl, opts) {
    cfg = normalizeCfg(cfg);
    opts = opts || {};
    // Ключ опционален: в прокси-режиме его подставляет сервер (пустой Authorization не отправляется).
    var f = opts.fetchImpl || fetchImpl || global.fetch;
    if (!f) return Promise.reject({ code: "NO_FETCH", message: "Нет fetch-реализации." });
    var signal = opts.signal || null;
    if (signal && signal.aborted) return Promise.reject({ code: "CANCELLED", message: "Отменено пользователем." });

    var retries = (opts.retries != null) ? opts.retries : cfg.retries;
    var timeoutMs = opts.timeoutMs || cfg.timeoutMs;
    var backoffMs = cfg.backoffMs;
    var url = cfg.baseUrl + "/chat/completions";
    var body = JSON.stringify({ model: cfg.model, temperature: cfg.temperature, messages: messages });
    var attempt = 0;

    function once() {
      var ac = (typeof AbortController === "function") ? new AbortController() : null;
      var tid = ac ? setTimeout(function () { ac.abort(); }, timeoutMs) : null;
      var onOuter = null;
      if (ac && signal) {
        if (signal.aborted) ac.abort();
        else {
          onOuter = function () { ac.abort(); };
          signal.addEventListener("abort", onOuter);
        }
      }
      function cleanup() {
        if (tid) clearTimeout(tid);
        if (onOuter && signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onOuter);
      }
      return f(url, {
        method: "POST",
        headers: cfg.apiKey
          ? { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey }
          : { "Content-Type": "application/json" },
        body: body,
        signal: ac ? ac.signal : undefined
      }).catch(function (e) {
        // сетевой сбой / прерывание fetch → унифицируем в объект с кодом
        if (e && e.code) throw e;
        if (e && e.name === "AbortError") {
          throw { code: (signal && signal.aborted) ? "CANCELLED" : "TIMEOUT", message: "Превышен таймаут запроса или запрос отменён.", retriable: true };
        }
        throw { code: "NET", message: (e && e.message) || "Сетевая ошибка.", retriable: true };
      }).then(function (res) {
        if (!res.ok) {
          throw {
            code: "HTTP_" + res.status,
            message: "Ответ модели " + res.status,
            status: res.status,
            retryAfter: parseRetryAfter(res),
            retriable: res.status === 429 || res.status >= 500
          };
        }
        return res.json().catch(function () {
          throw { code: "BAD_BODY", message: "Некорректный JSON в ответе.", retriable: true };
        });
      }).then(function (data) {
        var text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) throw { code: "BAD_SHAPE", message: "Непонятный ответ модели.", retriable: false };
        return String(text).trim();
      }).then(
        function (ok) { cleanup(); return ok; },
        function (err) { cleanup(); throw err; }
      );
    }

    function loop() {
      return once().catch(function (e) {
        if (signal && signal.aborted) throw { code: "CANCELLED", message: "Отменено пользователем." };
        if (e && e.retriable && attempt < retries) {
          attempt++;
          var delay = (e.retryAfter != null) ? e.retryAfter : backoffMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
          return sleep(delay).then(loop);
        }
        throw e;
      });
    }
    return Promise.resolve().then(loop);
  }

  // Разворачивает все разделы каркаса. opts:
  //   words, fetchImpl, signal, concurrency (по умолчанию 1),
  //   sections — уже готовые результаты (дозапуск: непустые ключи пропускаются),
  //   onStart(task) — раздел начал писаться; onProgress(done, total, task) — раздел завершён;
  //   onError(task, error) — раздел не удался после всех попыток.
  // Возвращает { sections, errors, tasks }.
  function expand(bp, cfg, opts) {
    opts = opts || {};
    var P = (typeof require === "function") ? require("./prompts.js") : global.MLPrompts;
    var tasks = P.buildTasks(bp, opts.words);
    var results = {};
    var keys = Object.keys(opts.sections || {});
    for (var k = 0; k < keys.length; k++) {
      if (opts.sections[keys[k]]) results[keys[k]] = opts.sections[keys[k]];
    }
    var errors = [];
    var queue = tasks.filter(function (t) { return !results[t.key]; });
    var total = queue.length;
    var idx = 0, done = 0, cancelled = false;
    var concurrency = Math.max(1, opts.concurrency || 1);
    var signal = opts.signal || null;

    function worker() {
      if (cancelled || (signal && signal.aborted)) return Promise.resolve();
      if (idx >= queue.length) return Promise.resolve();
      var t = queue[idx++];
      if (opts.onStart) opts.onStart(t);
      return chat(
        [{ role: "system", content: P.SYSTEM }, { role: "user", content: t.prompt }],
        cfg, opts.fetchImpl, { signal: signal }
      ).then(function (text) {
        results[t.key] = text;
      }).catch(function (e) {
        results[t.key] = results[t.key] || "";
        if (e && e.code === "CANCELLED") {
          cancelled = true; idx = queue.length; // стоп очереди
          errors.push({ task: t, error: e });
        } else {
          errors.push({ task: t, error: e });
          if (opts.onError) opts.onError(t, e);
        }
      }).then(function () {
        done++;
        if (opts.onProgress) opts.onProgress(done, total, t);
        return worker();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.max(1, Math.min(concurrency, total)); w++) workers.push(worker());
    return Promise.all(workers).then(function () {
      return { sections: results, errors: errors, tasks: tasks };
    });
  }

  // Собирает развёрнутый документ в Markdown из каркаса + результатов секций.
  function assembleMarkdown(bp, sections) {
    var E = (typeof require === "function") ? require("./engine.js") : global.MLResearchEngine;
    sections = sections || {};
    var L = [];
    L.push("# " + bp.meta.topic);
    L.push("_" + bp.kindLabel + " · методология: диалектический и исторический материализм_");
    L.push("");
    L.push("> Учебный черновик-каркас, развёрнутый моделью. Проверьте факты и ссылки, доработайте перед сдачей.");
    L.push("");
    if (sections.intro) { L.push("## Введение\n\n" + sections.intro + "\n"); }
    bp.structure.chapters.forEach(function (c, ci) {
      L.push("## " + c.title + "\n");
      c.sub.forEach(function (s, si) {
        var key = "ch" + (ci + 1) + "_" + (si + 1);
        L.push("### " + s + "\n\n" + (sections[key] || "_[не развёрнуто]_") + "\n");
      });
    });
    if (sections.concl) { L.push("## Заключение\n\n" + sections.concl + "\n"); }
    L.push("## Список литературы (каркас)\n");
    bp.literature.forEach(function (r, i) { L.push((i + 1) + ". " + r); });
    return L.join("\n");
  }

  return {
    DEFAULTS: DEFAULTS, normalizeCfg: normalizeCfg, chat: chat, expand: expand, assembleMarkdown: assembleMarkdown
  };
});
