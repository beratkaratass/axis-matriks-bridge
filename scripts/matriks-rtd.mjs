import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const GS = "\x1d";
const RS = "\x1e";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISTANBUL_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Istanbul", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export const encodeRtdMessage = (type, ...tokens) => `${type}${tokens.map((token) => `${GS}${token}`).join("")}${RS}`;

export function createRtdDecoder(onUpdate, onError = () => undefined) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 8 * 1024 * 1024) {
        buffer = "";
        onError(new Error("Matriks RTD frame buffer exceeded 8 MB"));
        return;
      }
      const messages = buffer.split(RS);
      buffer = messages.pop() ?? "";
      for (const message of messages) {
        const tokens = message.split(GS);
        const topicId = Number(tokens[1]);
        if (tokens[0] === "3" && Number.isSafeInteger(topicId) && topicId > 0 && tokens.length >= 3) {
          onUpdate(topicId, tokens.slice(2).join(GS));
        }
      }
    },
    reset() { buffer = ""; },
  };
}

function value(raw) {
  const text = String(raw).trim();
  if (!text) return null;
  const number = Number(text.includes(",") ? text.replaceAll(".", "").replace(",", ".") : text);
  return Number.isFinite(number) ? number : text;
}

export function exchangeEventTime(raw, now = Date.now()) {
  const match = String(raw ?? "").match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const local = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  let event = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(match[1]) - 3, Number(match[2]), Number(match[3]));
  if (event > now + 5 * 60_000) event -= 86_400_000;
  return event;
}

export function isBistEquitySession(now = Date.now()) {
  const local = Object.fromEntries(ISTANBUL_CLOCK.formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  if (local.weekday === "Sat" || local.weekday === "Sun") return false;
  const minute = Number(local.hour) * 60 + Number(local.minute);
  return minute >= 9 * 60 + 40 && minute <= 18 * 60 + 10;
}

export function applyRtdUpdate(state, subscriptions, topicId, raw, now = Date.now(), bistSymbols = new Set(), futureToleranceMs = 90_000) {
  const subscription = subscriptions[topicId];
  if (!subscription) return false;
  const parsed = value(raw);
  if (parsed === null) return false;

  const { symbol, field } = subscription;
  const updatedAt = new Date(now).toISOString();
  const quote = state.quotes[symbol] ??= { symbol };
  quote[field] = parsed;
  quote.raw = String(raw);
  quote.updatedAt = updatedAt;
  if (field === "ALIS.TRY") quote.bidUpdatedAt = updatedAt;
  else if (field === "SATIS.TRY") quote.askUpdatedAt = updatedAt;
  state.capturedAt = updatedAt;

  const last = Number(quote["SON.TRY"]);
  const bid = Number(quote["ALIS.TRY"]);
  const ask = Number(quote["SATIS.TRY"]);
  const price = Number.isFinite(last) && last > 0 ? last
    : Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  if (price === null) return true;

  const exchangeAt = exchangeEventTime(quote.SAAT, now);
  if (bistSymbols.has(symbol) && (!isBistEquitySession(now) || exchangeAt === null || now - exchangeAt < -futureToleranceMs || now - exchangeAt > 5 * 60_000)) return true;
  const bucket = Math.floor((exchangeAt ?? now) / 60_000) * 60;
  const bars = state.candles[symbol] ??= [];
  const bar = bars.at(-1);
  if (bar?.time === bucket) {
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
  } else {
    bars.push({ time: bucket, open: price, high: price, low: price, close: price, volume: 0 });
    if (bars.length > 1_000) bars.splice(0, bars.length - 1_000);
  }
  const turnover = Number(quote["THACIM.TRY"]);
  if (Number.isFinite(turnover) && bars.length) {
    const current = bars.at(-1), previous = bars.at(-2);
    current.turnover = turnover;
    current.volume = Number.isFinite(previous?.turnover) && turnover >= previous.turnover ? turnover - previous.turnover : previous ? turnover : 0;
  }
  return true;
}

const stamp = (date = new Date()) => {
  const pad = (number, width = 2) => String(number).padStart(width, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 4)}`;
};

function readList(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")) : [];
}

export function xautryContracts(now = Date.now()) {
  const start = new Date(now), contracts = [];
  for (let offset = 0; contracts.length < 3; offset++) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
    const month = date.getUTCMonth() + 1;
    if (month % 2 === 0) contracts.push(`F_XAUTRYM${String(month).padStart(2, "0")}${String(date.getUTCFullYear()).slice(-2)}`);
  }
  return contracts;
}

export function xu030Contracts(now = Date.now()) {
  const start = new Date(now), contracts = [];
  for (let offset = 0; contracts.length < 3; offset++) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
    const month = date.getUTCMonth() + 1;
    if (month % 2 === 0) contracts.push(`F_XU030${String(month).padStart(2, "0")}${String(date.getUTCFullYear()).slice(-2)}`);
  }
  return contracts;
}

export function rtdNeedsReconnect(state, expectedSubscriptions, now = Date.now(), staleMs = 90_000) {
  const capturedAt = Date.parse(state.capturedAt);
  return isBistEquitySession(now) && state.connected && state.subscribed === expectedSubscriptions
    && (!Number.isFinite(capturedAt) || now - capturedAt > staleMs);
}

export function restoreRtdState(value, symbols, now = Date.now(), bistSymbols = new Set()) {
  const saved = value && typeof value === "object" && value.version === 1 ? value : {};
  const validBar = (bar) => bar && typeof bar === "object"
    && [bar.time, bar.open, bar.high, bar.low, bar.close].every((item) => Number.isFinite(item) && item > 0);
  return {
    version: 1, service: "MTXIQRTD", topic: "DATA", candleClock: "exchange", connected: false, subscribed: 0,
    capturedAt: new Date(now).toISOString(),
    quotes: Object.fromEntries(symbols.map((symbol) => [symbol,
      saved.quotes?.[symbol] && typeof saved.quotes[symbol] === "object" ? { ...saved.quotes[symbol], symbol } : { symbol }])),
    candles: Object.fromEntries(symbols.flatMap((symbol) => {
      const bars = bistSymbols.has(symbol) && saved.candleClock !== "exchange" ? []
        : Array.isArray(saved.candles?.[symbol]) ? saved.candles[symbol].filter(validBar).slice(-1_000) : [];
      return bars.length ? [[symbol, bars]] : [];
    })),
  };
}

export function pendingCompletedRtdBars(state, archivedThrough) {
  const rows = [];
  for (const [symbol, bars] of Object.entries(state.candles ?? {})) {
    if (!Array.isArray(bars) || bars.length < 2) continue;
    const pending = [];
    const through = archivedThrough.get(symbol) ?? 0;
    for (let index = bars.length - 2; index >= 0 && bars[index].time > through; index--) {
      pending.push({ symbol, ...bars[index], volume: Number.isFinite(bars[index].volume) ? bars[index].volume : 0 });
    }
    rows.push(...pending.reverse());
  }
  return rows;
}

export function createRtdArchive(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL, time INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
      PRIMARY KEY (symbol, time)
    ) WITHOUT ROWID;`);
  const archivedThrough = new Map(db.prepare("SELECT symbol, MAX(time) AS time FROM candles GROUP BY symbol").all()
    .map((row) => [String(row.symbol), Number(row.time)]));
  const insert = db.prepare(`INSERT INTO candles (symbol, time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, time) DO UPDATE SET open=excluded.open, high=excluded.high,
      low=excluded.low, close=excluded.close, volume=excluded.volume`);
  return {
    write(state) {
      const rows = pendingCompletedRtdBars(state, archivedThrough);
      if (!rows.length) return 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) insert.run(row.symbol, row.time, row.open, row.high, row.low, row.close, row.volume);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* keep original archive error */ }
        throw error;
      }
      for (const row of rows) archivedThrough.set(row.symbol, Math.max(archivedThrough.get(row.symbol) ?? 0, row.time));
      return rows.length;
    },
    count: () => Number(db.prepare("SELECT COUNT(*) AS count FROM candles").get().count),
    deleteSymbols(symbols) {
      const remove = db.prepare("DELETE FROM candles WHERE symbol = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const symbol of symbols) { remove.run(symbol); archivedThrough.delete(symbol); }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* keep original archive error */ }
        throw error;
      }
    },
    close: () => db.close(),
  };
}

function numberEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function main() {
  const output = path.resolve(process.argv[2] || path.join(ROOT, "data", "matriks-dde.json"));
  const config = path.join(ROOT, "config");
  const bistSymbols = new Set(readList(path.join(config, "bist100-current.txt")));
  let symbols = [...new Set([
    ...readList(path.join(config, "matriks-symbols.txt")),
    ...readList(path.join(config, "matriks-extra-symbols.txt")),
    ...readList(path.join(config, "matriks-crypto-symbols.txt")),
    ...xautryContracts(),
    ...xu030Contracts(),
  ])].sort();
  const filter = process.env.MATRIKS_DDE_SYMBOL_FILTER;
  if (filter) symbols = symbols.filter((symbol) => new RegExp(filter).test(symbol));
  const fields = (process.env.MATRIKS_DDE_FIELDS || "SON.TRY,ACKL,ALIS.TRY,SATIS.TRY,FARK.TRY,FARKY,GUNFY,YUKSEK.TRY,DUSUK.TRY,TADET,THACIM.TRY,SAAT")
    .split(",").map((field) => field.trim()).filter(Boolean);
  if (!symbols.length || !fields.length) throw new Error("No Matriks RTD symbols or fields are configured");

  const subscriptions = [null];
  for (const symbol of symbols) for (const field of fields) subscriptions.push({ symbol, field, topic: `DATA.${symbol}.${field}` });
  let saved = null;
  try { if (existsSync(output)) saved = JSON.parse(readFileSync(output, "utf8").replace(/^\uFEFF/, "")); }
  catch { saved = null; }
  const state = restoreRtdState(saved, symbols, Date.now(), bistSymbols);
  const host = process.env.MATRIKS_RTD_HOST || "127.0.0.1";
  const port = Number(process.env.MATRIKS_RTD_PORT || 8948);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("MATRIKS_RTD_PORT is invalid");
  const staleMs = numberEnv("MATRIKS_RTD_STALE_MS", 90_000, 30_000, 900_000);
  const bistFutureMs = numberEnv("MATRIKS_BIST_CLOCK_FUTURE_MS", 90_000, 5_000, 300_000);
  const writeMs = numberEnv("MATRIKS_DDE_WRITE_MS", 1_000, 250, 10_000);
  const archive = createRtdArchive(path.resolve(process.env.MATRIKS_DDE_ARCHIVE_FILE || path.join(ROOT, "data", "matriks-candles.sqlite")));
  if (saved?.candleClock !== "exchange") archive.deleteSymbols(bistSymbols);

  let socket = null;
  let reconnect = null;
  let subscriptionTimer = null;
  let writeTimer = null;
  let stopped = false;
  let lastError = "";
  let lastArchiveError = "";
  const write = () => {
    writeTimer = null;
    try {
      archive.write(state);
      if (lastArchiveError) console.log("[matriks-rtd] candle archive recovered");
      lastArchiveError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastArchiveError) console.error(`[matriks-rtd] candle archive failed: ${message}`);
      lastArchiveError = message;
    }
    mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), "utf8");
    try { renameSync(temporary, output); }
    catch (error) {
      if (["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
        writeTimer = setTimeout(write, 50);
        return;
      }
      throw error;
    }
  };
  const scheduleWrite = (delay = writeMs) => { if (!writeTimer) writeTimer = setTimeout(write, delay); };
  const decoder = createRtdDecoder((topicId, raw) => {
    if (applyRtdUpdate(state, subscriptions, topicId, raw, Date.now(), bistSymbols, bistFutureMs)) scheduleWrite();
  }, (error) => console.error(`[matriks-rtd] ${error.message}`));

  const connect = () => {
    decoder.reset();
    const next = net.createConnection({ host, port });
    socket = next;
    next.setEncoding("utf8");
    next.setKeepAlive(true, 30_000);
    next.once("connect", () => {
      lastError = "";
      state.connected = true;
      state.subscribed = 0;
      state.capturedAt = new Date().toISOString();
      const started = stamp();
      const batchSize = numberEnv("MATRIKS_DDE_BATCH_SIZE", 25, 1, 1_000);
      const batchDelay = numberEnv("MATRIKS_DDE_BATCH_DELAY_MS", 100, 0, 10_000);
      let cursor = 1;
      next.write(encodeRtdMessage(0, started));
      write();
      const subscribe = () => {
        subscriptionTimer = null;
        if (socket !== next || next.readyState !== "open") return;
        const end = Math.min(cursor + batchSize, subscriptions.length);
        next.write(subscriptions.slice(cursor, end).map((item, index) => encodeRtdMessage(2, cursor + index, item.topic)).join(""));
        cursor = end;
        state.subscribed = cursor - 1;
        state.capturedAt = new Date().toISOString();
        scheduleWrite();
        if (cursor < subscriptions.length) subscriptionTimer = setTimeout(subscribe, batchDelay);
        else console.log(`[matriks-rtd] subscribed ${state.subscribed} topics for ${symbols.length} symbols at ${host}:${port}`);
      };
      subscribe();
    });
    next.on("data", (chunk) => decoder.push(chunk));
    next.once("error", (error) => { lastError = error.message; });
    next.once("close", () => {
      if (socket === next) socket = null;
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      subscriptionTimer = null;
      state.connected = false;
      state.subscribed = 0;
      state.capturedAt = new Date().toISOString();
      write();
      if (lastError && lastError !== "connect ECONNREFUSED 127.0.0.1:8948") console.error(`[matriks-rtd] ${lastError}`);
      if (!stopped) reconnect = setTimeout(connect, 2_000);
    });
  };
  const watchdog = setInterval(() => {
    if (socket?.readyState !== "open" || !rtdNeedsReconnect(state, subscriptions.length - 1, Date.now(), staleMs)) return;
    lastError = `RTD stream stalled for ${Math.round(staleMs / 1_000)}s`;
    socket.destroy();
  }, 30_000);
  const shutdown = () => {
    stopped = true;
    clearInterval(watchdog);
    if (reconnect) clearTimeout(reconnect);
    if (subscriptionTimer) clearTimeout(subscriptionTimer);
    if (writeTimer) clearTimeout(writeTimer);
    if (socket?.readyState === "open") socket.write(encodeRtdMessage(1, stamp()));
    socket?.destroy();
    state.connected = false;
    state.subscribed = 0;
    state.capturedAt = new Date().toISOString();
    write();
    archive.close();
  };
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });
  connect();
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try { main(); }
  catch (error) { console.error(`[matriks-rtd] ${error.message}`); process.exit(1); }
}
