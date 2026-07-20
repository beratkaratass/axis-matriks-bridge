#!/usr/bin/env node
// MatriksIQ localhost TCP -> outbound HTTPS snapshots and guarded demo execution.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNewOrder, encodeOrderPacket, findDemoAccount } from "./matriks-order.mjs";

const VT = "\x0b";
export const BRIDGE_VERSION = "2.2.2";
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 900_000;
const TERMINAL_ORDER_STATUSES = new Set(["2", "4", "5", "7", "8", "C", "Z"]);
export const READ_ONLY_COMMANDS = new Set([0, 1, 2, 6, 7, 8, 9, 10, 11]);

const asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const field = (row, ...names) => {
  for (const name of names) if (row?.[name] !== undefined) return row[name];
  return undefined;
};
const scope = (row) => ({
  BrokageId: String(field(row, "BrokageId", "BrokerageId") ?? ""),
  AccountId: String(field(row, "AccountId", "AccountID") ?? ""),
  ExchangeId: Number(field(row, "ExchangeId", "ExchangeID", "ExchangeType") ?? 0),
});
const sameScope = (row, wanted) => {
  const current = scope(row);
  return current.BrokageId === wanted.BrokageId && current.AccountId === wanted.AccountId && current.ExchangeId === wanted.ExchangeId;
};
const sameAccount = (row, wanted) => {
  const current = scope(row);
  return current.BrokageId === wanted.BrokageId && current.AccountId === wanted.AccountId;
};

export function encodePacket(packet) {
  const command = Number(packet?.ApiCommands);
  if (!READ_ONLY_COMMANDS.has(command)) throw new Error(`Refusing non-read-only Matriks command ${command}`);
  return `${JSON.stringify(packet)}${VT}`;
}

export function createFrameDecoder(onPacket, onError = () => undefined) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFER) {
        buffer = "";
        onError(new Error("Matriks frame buffer exceeded 8 MB"));
        return;
      }
      for (;;) {
        const end = buffer.indexOf(VT);
        if (end < 0) return;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!frame) continue;
        try { onPacket(JSON.parse(frame)); }
        catch (error) { onError(error); }
      }
    },
    reset() { buffer = ""; },
  };
}

export function createState(agentId) {
  return {
    version: 1,
    agentId,
    agentVersion: BRIDGE_VERSION,
    matriks: { connected: false, connectedAt: null, lastPacketAt: null, lastError: null },
    accounts: [],
    accountInformation: [],
    positions: [],
    orders: [],
    filledOrders: [],
    canceledOrders: [],
    events: [],
    trading: { lastCommandId: null, status: "idle", message: null, at: null, liveAllowed: false },
  };
}

export function validateTradingCommand(value, allowLive = false) {
  const command = asRecord(value);
  if (!command || typeof command.id !== "string" || !/^[0-9a-f-]{36}$/i.test(command.id)
      || command.strategy !== "bist-zirve" || !["demo", "live"].includes(command.mode) || command.mode === "live" && !allowLive
      || !Number.isFinite(Date.parse(String(command.createdAt))) || !Number.isFinite(command.signalAt)
      || !Number.isFinite(command.capitalTry) || command.capitalTry < 100_000 || command.capitalTry > 100_000_000
      || !Array.isArray(command.targets) || command.targets.length !== 2) throw new Error("Geçersiz veya izinsiz Zirve emir komutu");
  const selector = asRecord(command.account);
  if (command.mode === "live" && (!selector || !/^[A-Za-z0-9._-]{1,64}$/.test(String(selector.brokerageId))
      || !/^[A-Za-z0-9]{4}$/.test(String(selector.accountSuffix)))) throw new Error("Geçersiz gerçek hesap seçimi");
  const targets = command.targets.map((target) => {
    const row = asRecord(target);
    const symbol = String(row?.symbol ?? "").toUpperCase();
    const quantity = Number(row?.quantity);
    if (!/^F_(?:XU030|XAUTRYM)\d{4}$/.test(symbol) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1_000_000) {
      throw new Error("Komut izin verilmeyen sembol veya miktar içeriyor");
    }
    return { symbol, quantity };
  });
  if (!targets.some(({ symbol }) => symbol.startsWith("F_XU030")) || !targets.some(({ symbol }) => symbol.startsWith("F_XAUTRYM"))) {
    throw new Error("Komutta iki Zirve kontrat ayağı bulunmalı");
  }
  return { ...command, account: command.mode === "live" ? {
    brokerageId: String(selector.brokerageId), accountSuffix: String(selector.accountSuffix),
    brokerageName: String(selector.brokerageName ?? "").slice(0, 100),
  } : null, targets };
}

function findLiveAccount(accounts, selector) {
  const matches = [];
  for (const brokerage of Array.isArray(accounts) ? accounts : []) {
    const brokerageId = String(field(brokerage, "BrokageId", "BrokerageId") ?? "");
    if (brokerageId !== selector.brokerageId || findDemoAccount([brokerage], 9)) continue;
    for (const account of Array.isArray(brokerage?.AccountIdList) ? brokerage.AccountIdList : []) {
      const accountId = String(field(account, "AccountId", "AccountID") ?? "");
      if (Number(field(account, "ExchangeId", "ExchangeID")) === 9 && accountId.endsWith(selector.accountSuffix)) {
        matches.push({ brokerageId, brokerageName: String(field(brokerage, "BrokageName", "BrokerageName") ?? ""), accountId, exchangeId: 9 });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

const netPosition = (row) => {
  const direct = Number(field(row, "QtyNet", "NetQty", "NetQuantity", "Quantity"));
  if (Number.isFinite(direct)) return Math.trunc(direct);
  const long = Number(field(row, "QtyLong", "LongQty") ?? 0), short = Number(field(row, "QtyShort", "ShortQty") ?? 0);
  return Number.isFinite(long) && Number.isFinite(short) ? Math.trunc(long - short) : 0;
};

export function buildTradingOrder(commandInput, state, dde, { allowLive = false } = {}) {
  const command = validateTradingCommand(commandInput, allowLive);
  const account = command.mode === "live" ? findLiveAccount(state.accounts, command.account) : findDemoAccount(state.accounts, 9);
  if (!account) return { status: "rejected", message: `${command.mode === "live" ? "Seçili gerçek" : "Matriks Deneme Ortamı"} VİOP hesabı bulunamadı`, packet: null };
  const wanted = { BrokageId: account.brokerageId, AccountId: account.accountId, ExchangeId: account.exchangeId };
  const packetForDifference = (symbol, difference, index) => {
    const quote = asRecord(dde?.quotes?.[symbol]);
    const preferred = difference > 0 ? Number(field(quote, "SATIS.TRY")) : Number(field(quote, "ALIS.TRY"));
    const fallback = Number(field(quote, "SON.TRY"));
    const price = Number.isFinite(preferred) && preferred > 0 ? preferred : fallback;
    if (!Number.isFinite(price) || price <= 0) return { status: "rejected", message: `${symbol} canlı fiyatı bulunamadı`, packet: null };
    const clientOrderId = `${String(Date.parse(command.createdAt)).slice(-13)}${index}${String(Math.abs(difference)).slice(-6).padStart(6, "0")}`;
    return {
      status: "submitted",
      message: `${symbol} ${difference > 0 ? "AL" : "SAT"} ${Math.abs(difference)} @ ${price}`,
      packet: createNewOrder({
        brokerageId: account.brokerageId, accountId: account.accountId, symbol,
        side: difference > 0 ? "buy" : "sell", quantity: Math.abs(difference), price, clientOrderId,
      }),
    };
  };
  for (let index = 0; index < command.targets.length; index++) {
    const target = command.targets[index];
    const family = target.symbol.startsWith("F_XU030") ? "F_XU030" : "F_XAUTRYM";
    const stale = state.positions.find((row) => sameScope(row, wanted)
      && String(field(row, "Symbol") ?? "").toUpperCase().startsWith(family)
      && String(field(row, "Symbol") ?? "").toUpperCase() !== target.symbol && netPosition(row) !== 0);
    if (stale) {
      const symbol = String(field(stale, "Symbol")).toUpperCase();
      if (state.orders.some((row) => sameAccount(row, wanted) && String(field(row, "Symbol") ?? "").toUpperCase() === symbol)) {
        return { status: "noop", message: `${symbol} vade kapatma emri bekliyor`, packet: null };
      }
      return packetForDifference(symbol, -netPosition(stale), index);
    }
    const openOrder = state.orders.some((row) => sameAccount(row, wanted)
      && String(field(row, "Symbol") ?? "").toUpperCase() === target.symbol);
    if (openOrder) return { status: "noop", message: `${target.symbol} için bekleyen emir var`, packet: null };
    const current = state.positions
      .filter((row) => sameScope(row, wanted) && String(field(row, "Symbol") ?? "").toUpperCase() === target.symbol)
      .reduce((sum, row) => sum + netPosition(row), 0);
    const difference = target.quantity - current;
    if (!difference) continue;
    return packetForDifference(target.symbol, difference, index);
  }
  return { status: "noop", message: `Zirve ${command.mode === "live" ? "gerçek hesap" : "demo"} pozisyonları hedefle eşit`, packet: null };
}

function replaceScope(list, items, packet, maxItems = 20_000) {
  const wanted = scope(packet);
  return [...list.filter((row) => !sameScope(row, wanted)), ...items].slice(-maxItems);
}

function entityKey(item, kind) {
  return kind === "position"
    ? `${scope(item).BrokageId}|${scope(item).AccountId}|${scope(item).ExchangeId}|${field(item, "PositionId", "PositionID", "Symbol")}`
    : `${scope(item).BrokageId}|${scope(item).AccountId}|${field(item, "OrderId", "OrderID", "ClientOrderId", "ClientOrderID")}`;
}

function upsert(list, item, kind) {
  const id = entityKey(item, kind);
  return [...list.filter((row) => entityKey(row, kind) !== id), item].slice(-20_000);
}

function remove(list, item, kind) {
  const id = entityKey(item, kind);
  return list.filter((row) => entityKey(row, kind) !== id);
}

export function accountQueries(accounts) {
  const requests = [];
  for (const broker of accounts) {
    for (const account of Array.isArray(broker?.AccountIdList) ? broker.AccountIdList : []) {
      const base = {
        BrokageId: String(field(broker, "BrokageId", "BrokerageId") ?? ""),
        AccountId: String(field(account, "AccountId", "AccountID") ?? ""),
        ExchangeId: Number(field(account, "ExchangeId", "ExchangeID") ?? 0),
      };
      if (!base.BrokageId || !base.AccountId || !Number.isFinite(base.ExchangeId)) continue;
      for (const ApiCommands of [1, 2, 7, 8, 9]) requests.push({ ...base, ApiCommands });
    }
  }
  return requests;
}

function orderRefreshQueries(packet) {
  const wanted = scope(packet);
  if (!wanted.BrokageId || !wanted.AccountId || !Number.isFinite(wanted.ExchangeId)) return [{ ApiCommands: 0 }];
  return [2, 7, 8, 9].map((ApiCommands) => ({ ...wanted, ApiCommands }));
}

export function reducePacket(state, input, receivedAt = new Date().toISOString()) {
  const packet = asRecord(input);
  if (!packet) return { queries: [] };
  const command = Number(packet.ApiCommands);
  state.matriks.lastPacketAt = receivedAt;
  state.events = [{ receivedAt, apiCommands: Number.isFinite(command) ? command : null }, ...state.events].slice(0, 30);

  if (command === 0 && Array.isArray(packet.Accounts)) {
    state.accounts = packet.Accounts;
    return { queries: accountQueries(packet.Accounts) };
  }
  if (Array.isArray(packet.Informations)) {
    const wanted = scope(asRecord(packet.Request) ?? packet);
    const item = { ...wanted, Informations: packet.Informations.filter(asRecord).slice(0, 500) };
    state.accountInformation = replaceScope(state.accountInformation, [item], item, 100);
    return { queries: [] };
  }
  if (command === 1 && Array.isArray(packet.PositionResponseList)) {
    state.positions = replaceScope(
      state.positions,
      packet.PositionResponseList,
      packet,
      10_000,
    );
  } else if (command === 2 && Array.isArray(packet.OrderApiModels)) {
    state.orders = replaceScope(state.orders, packet.OrderApiModels, packet);
  } else if (command === 3) {
    const orderStatus = String(field(packet, "OrdStatus") ?? "").trim().toUpperCase();
    if (TERMINAL_ORDER_STATUSES.has(orderStatus)) {
      state.orders = remove(state.orders, packet, "order");
      return { queries: orderRefreshQueries(packet) };
    }
    state.orders = upsert(state.orders, packet, "order");
  } else if (command === 4) {
    if (packet.RemovePosition === true) {
      const current = upsert(state.positions, packet, "position");
      state.positions = current.filter((row) => row !== packet);
    } else {
      state.positions = upsert(state.positions, packet, "position");
    }
  } else if (command === 5 || command === 6) {
    return { queries: [{ ApiCommands: 0 }] };
  } else if (command === 9 && Array.isArray(packet.FilledOrderApiModels)) {
    state.filledOrders = replaceScope(state.filledOrders, packet.FilledOrderApiModels, packet);
  } else if (command === 10 && Array.isArray(packet.CanceledOrderApiModels)) {
    state.canceledOrders = replaceScope(state.canceledOrders, packet.CanceledOrderApiModels, packet);
  }
  return { queries: [] };
}

const maskAccount = (value) => {
  const text = String(value);
  return text.length <= 4 ? "****" : `****${text.slice(-4)}`;
};

function redact(value, key = "", depth = 0) {
  if (depth > 12) return null;
  if (/^accountid$/i.test(key) && value != null) return maskAccount(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, "", depth + 1));
  if (asRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  return value;
}

export function normalizeDdeSnapshot(value) {
  const state = asRecord(value);
  if (!state || state.version !== 1 || typeof state.connected !== "boolean"
      || !Number.isFinite(Date.parse(String(state.capturedAt))) || !asRecord(state.quotes) || !asRecord(state.candles)) return null;
  const validSymbol = (symbol) => symbol.length <= 100 && !/[\x00-\x1f]/.test(symbol);
  const quotes = Object.fromEntries(Object.entries(state.quotes).filter(([symbol, quote]) => validSymbol(symbol) && asRecord(quote)).slice(0, 5_000));
  const candles = Object.fromEntries(Object.entries(state.candles).filter(([symbol, bars]) => validSymbol(symbol) && Array.isArray(bars)).slice(0, 5_000).map(([symbol, bars]) => [
    symbol,
    bars.filter((bar) => {
      const row = asRecord(bar);
      return row && [row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)
        && Number(row.time) > 0 && Number(row.open) > 0 && Number(row.high) > 0 && Number(row.low) > 0 && Number(row.close) > 0;
    }).slice(-1_000),
  ]));
  return {
    version: 1,
    service: String(state.service ?? "MTXIQ").slice(0, 32),
    topic: String(state.topic ?? "DATA").slice(0, 32),
    connected: state.connected,
    subscribed: Number.isSafeInteger(state.subscribed) && state.subscribed >= 0 ? state.subscribed : 0,
    capturedAt: new Date(state.capturedAt).toISOString(),
    quotes,
    candles,
  };
}

export function snapshotForReport(state, sessionId, sequence, capturedAt = new Date().toISOString(), dde = null) {
  return redact({
    ...state,
    sessionId,
    sequence,
    snapshotId: `${sessionId}:${sequence}`,
    capturedAt,
    dde: normalizeDdeSnapshot(dde),
  });
}

export function encodeReport(snapshot, maxBytes = MAX_REPORT_BYTES) {
  const report = { ...snapshot };
  const lists = ["filledOrders", "canceledOrders", "events", "orders", "positions", "accountInformation", "accounts"];
  let body = JSON.stringify(report);
  let trimmed = false;

  while (Buffer.byteLength(body, "utf8") > maxBytes) {
    let largest = null;
    let largestBytes = 0;
    for (const name of lists) {
      if (!Array.isArray(report[name]) || report[name].length === 0) continue;
      const bytes = Buffer.byteLength(JSON.stringify(report[name]), "utf8");
      if (bytes > largestBytes) {
        largest = name;
        largestBytes = bytes;
      }
    }
    const candleEntries = asRecord(report.dde?.candles) ? Object.entries(report.dde.candles).filter(([, bars]) => Array.isArray(bars) && bars.length) : [];
    const candleBytes = candleEntries.length ? Buffer.byteLength(JSON.stringify(report.dde.candles), "utf8") : 0;
    if (candleBytes > largestBytes) {
      const canHalve = candleEntries.some(([, bars]) => bars.length > 1);
      const kept = canHalve
        ? candleEntries.map(([symbol, bars]) => [symbol, bars.slice(-Math.max(1, Math.floor(bars.length / 2)))])
        : candleEntries.slice(Math.ceil(candleEntries.length / 2));
      report.dde = { ...report.dde, candles: Object.fromEntries(kept) };
      trimmed = true;
      body = JSON.stringify(report);
      continue;
    }
    if (!largest) throw new Error("Matriks snapshot metadata exceeds the report size limit");

    const items = report[largest];
    const keep = Math.floor(items.length / 2);
    report[largest] = keep === 0
      ? []
      : largest === "events" ? items.slice(0, keep) : items.slice(-keep);
    trimmed = true;
    body = JSON.stringify(report);
  }
  return { body, trimmed };
}

function readDdeSnapshot(file) {
  try { return normalizeDdeSnapshot(JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))); }
  catch { return null; }
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#") || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const numberEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
};

export function sshTunnelArgs(reportUrl, target) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(target)) throw new Error("MATRIKS_SSH_TARGET is invalid");
  if (reportUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(reportUrl.hostname) || !reportUrl.port) {
    throw new Error("MATRIKS_SSH_TARGET requires a localhost HTTP MATRIKS_SERVER_URL with an explicit port");
  }
  return [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `127.0.0.1:${reportUrl.port}:127.0.0.1:3100`,
    target,
  ];
}

export function retryTunnelAfterFailure(child, restart, schedule = setTimeout) {
  let handled = false;
  const retry = (kind, detail) => {
    if (handled) return;
    handled = true;
    schedule(() => restart(kind, detail), 5_000);
  };
  child.once("error", (error) => retry("failed", error.message));
  child.once("exit", (code, signal) => retry("exited", code ?? signal ?? "unknown"));
}

async function main() {
  loadEnv(path.resolve(process.env.MATRIKS_AGENT_ENV || ".env.matriks"));
  const server = process.env.MATRIKS_SERVER_URL;
  const token = process.env.MATRIKS_AGENT_TOKEN;
  if (!server) throw new Error("MATRIKS_SERVER_URL is required");
  if (!token || token.length < 32) throw new Error("MATRIKS_AGENT_TOKEN must be at least 32 characters");

  const reportUrl = new URL("/api/matriks", server);
  const localHttp = ["localhost", "127.0.0.1", "::1"].includes(reportUrl.hostname);
  if (reportUrl.protocol !== "https:" && !localHttp && process.env.MATRIKS_ALLOW_HTTP !== "1") {
    throw new Error("Refusing to send financial data without HTTPS (set MATRIKS_ALLOW_HTTP=1 only on a private test network)");
  }

  const host = process.env.MATRIKS_HOST || "127.0.0.1";
  const port = numberEnv("MATRIKS_PORT", 18890, 1, 65535);
  const reportMs = numberEnv("MATRIKS_REPORT_INTERVAL_MS", 5000, 1000, 60_000);
  const refreshMs = numberEnv("MATRIKS_REFRESH_INTERVAL_MS", 60_000, 10_000, 600_000);
  const ddeFile = path.resolve(process.env.MATRIKS_DDE_FILE || path.join("data", "matriks-dde.json"));
  const tradingFile = path.resolve(process.env.MATRIKS_TRADING_FILE || path.join("data", "matriks-agent-trading.json"));
  const agentId = (process.env.MATRIKS_AGENT_ID || `windows-${os.hostname()}`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  const sessionId = randomUUID().replaceAll("-", "");
  const state = createState(agentId);
  state.trading.liveAllowed = process.env.MATRIKS_REAL_TRADING === "1";
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reporting = false;
  let sequence = 0;
  let lastReportError = "";
  let lastReportTrimmed = false;
  let lastActive = null;
  let lastUpdateVersion = "";
  let ddeProcess = null;
  let tunnelProcess = null;
  let shuttingDown = false;
  let executedCommands = [];
  try {
    const saved = JSON.parse(readFileSync(tradingFile, "utf8"));
    if (Array.isArray(saved?.executedCommands)) executedCommands = saved.executedCommands.filter((id) => typeof id === "string").slice(-200);
  } catch { executedCommands = []; }

  const send = (packet) => {
    if (socket?.readyState === "open") socket.write(encodePacket(packet));
  };

  const completeTradingCommand = (command, status, message) => {
    executedCommands = [...new Set([...executedCommands, command.id])].slice(-200);
    mkdirSync(path.dirname(tradingFile), { recursive: true });
    writeFileSync(tradingFile, JSON.stringify({ version: 1, executedCommands }), "utf8");
    state.trading = { ...state.trading, lastCommandId: command.id, status, message: String(message).slice(0, 500), at: new Date().toISOString() };
  };

  const executeTradingCommand = (input, dde) => {
    const command = validateTradingCommand(input, state.trading.liveAllowed);
    if (executedCommands.includes(command.id) || state.trading.lastCommandId === command.id) {
      state.trading = { ...state.trading, lastCommandId: command.id, status: "noop", message: "Komut daha önce işlendi; tekrar gönderilmedi", at: new Date().toISOString() };
      return;
    }
    // Claim before socket submission: after a crash, missing one order is safer than duplicating it.
    completeTradingCommand(command, "noop", "Komut alındı");
    const result = buildTradingOrder(command, state, dde, { allowLive: state.trading.liveAllowed });
    if (result.packet) {
      if (socket?.readyState !== "open") throw new Error("Matriks emir soketi bağlı değil");
      socket.write(encodeOrderPacket(result.packet));
    }
    completeTradingCommand(command, result.status, result.message);
    console.log(`[matriks] Zirve ${command.mode}: ${result.message}`);
  };

  const decoder = createFrameDecoder((packet) => {
    const { queries } = reducePacket(state, packet);
    for (const query of queries) send(query);
  }, (error) => {
    state.matriks.lastError = `Invalid Matriks packet: ${error.message}`;
  });

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };

  const connect = () => {
    decoder.reset();
    const next = net.createConnection({ host, port });
    socket = next;
    next.setEncoding("utf8");
    next.setKeepAlive(true, 30_000);
    next.setTimeout(75_000);
    next.once("connect", () => {
      reconnectAttempt = 0;
      state.accounts = [];
      state.accountInformation = [];
      state.positions = [];
      state.orders = [];
      state.filledOrders = [];
      state.canceledOrders = [];
      state.matriks = { connected: true, connectedAt: new Date().toISOString(), lastPacketAt: null, lastError: null };
      next.write("SetMessageType0");
      send({ LoggingMode: 1, ApiCommands: 10 });
      send({ BroadcastMode: 0, ApiCommands: 11 });
      send({ ApiCommands: 0 });
      console.log(`[matriks] connected to ${host}:${port}`);
    });
    next.on("data", (chunk) => decoder.push(chunk));
    next.once("timeout", () => {
      state.matriks.lastError = "Matriks stopped responding";
      next.destroy();
    });
    next.once("error", (error) => {
      state.matriks.lastError = error.message;
    });
    next.once("close", () => {
      if (socket === next) socket = null;
      state.matriks.connected = false;
      console.error(`[matriks] disconnected${state.matriks.lastError ? `: ${state.matriks.lastError}` : ""}`);
      scheduleReconnect();
    });
  };

  const report = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const dde = readDdeSnapshot(ddeFile);
      const snapshot = snapshotForReport(state, sessionId, ++sequence, new Date().toISOString(), dde);
      const encoded = encodeReport(snapshot);
      const response = await fetch(reportUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: encoded.body,
        signal: AbortSignal.timeout(10_000),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Linux server returned HTTP ${response.status}`);
      let acknowledgement;
      try { acknowledgement = JSON.parse(responseText); }
      catch { throw new Error("Linux server returned an invalid acknowledgement"); }
      if (acknowledgement?.ok !== true) throw new Error("Linux server rejected the report");
      const active = acknowledgement.active !== false;
      if (active !== lastActive) {
        console.log(active
          ? "[matriks] active bridge"
          : `[matriks] standby bridge; active=${String(acknowledgement.activeAgentId || "unknown")}`);
        lastActive = active;
      }
      if (active && acknowledgement.tradingCommand) {
        try { executeTradingCommand(acknowledgement.tradingCommand, dde); }
        catch (error) {
          const command = asRecord(acknowledgement.tradingCommand);
          if (typeof command?.id === "string") completeTradingCommand(command, "error", error instanceof Error ? error.message : String(error));
          console.error(`[matriks] Zirve demo emri reddedildi: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (typeof acknowledgement.latestVersion === "string" && acknowledgement.latestVersion !== BRIDGE_VERSION
          && typeof acknowledgement.updateUrl === "string" && acknowledgement.updateUrl.startsWith("https://")
          && /^[a-fA-F0-9]{64}$/.test(String(acknowledgement.updateSha256 || ""))) {
        const updateFile = path.resolve("data", "matriks-update.json");
        mkdirSync(path.dirname(updateFile), { recursive: true });
        writeFileSync(updateFile, JSON.stringify({
          version: acknowledgement.latestVersion,
          url: acknowledgement.updateUrl,
          sha256: acknowledgement.updateSha256.toLowerCase(),
        }), "utf8");
        if (lastUpdateVersion !== acknowledgement.latestVersion) console.log(`[matriks] update available: ${acknowledgement.latestVersion}`);
        lastUpdateVersion = acknowledgement.latestVersion;
      }
      if (encoded.trimmed && !lastReportTrimmed) console.warn("[matriks] snapshot exceeded 900 KB; oldest rows or candles were omitted from this report");
      if (!encoded.trimmed && lastReportTrimmed) console.log("[matriks] snapshot reports are no longer truncated");
      lastReportTrimmed = encoded.trimmed;
      if (lastReportError) console.log("[matriks] reporting recovered");
      lastReportError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReportError) console.error(`[matriks] report failed: ${message}`);
      lastReportError = message;
    } finally {
      reporting = false;
    }
  };

  const keepalive = setInterval(() => send({ KeepAliveDate: new Date().toISOString(), ApiCommands: 6 }), 30_000);
  const refresh = setInterval(() => send({ ApiCommands: 0 }), refreshMs);
  const reporter = setInterval(report, reportMs);
  const shutdown = () => {
    shuttingDown = true;
    clearInterval(keepalive);
    clearInterval(refresh);
    clearInterval(reporter);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.destroy();
    if (ddeProcess && !ddeProcess.killed) ddeProcess.kill();
    if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
  };
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });

  console.log(`[matriks] agent ${agentId}; reports -> ${reportUrl.origin}`);
  if (process.env.MATRIKS_SSH_TARGET) {
    const args = sshTunnelArgs(reportUrl, process.env.MATRIKS_SSH_TARGET);
    const startTunnel = () => {
      if (shuttingDown) return;
      const next = spawn("ssh", args, { stdio: "inherit", windowsHide: true });
      tunnelProcess = next;
      retryTunnelAfterFailure(next, (kind, detail) => {
        if (shuttingDown) return;
        if (tunnelProcess === next) tunnelProcess = null;
        console.error(`[matriks] SSH tunnel ${kind} (${detail}); retrying`);
        startTunnel();
      });
      console.log(`[matriks] SSH tunnel enabled (${process.env.MATRIKS_SSH_TARGET})`);
    };
    startTunnel();
  }
  if (process.platform === "win32" && process.env.MATRIKS_DDE_AUTOSTART !== "0") {
    const ddeScript = path.resolve(path.dirname(process.argv[1]), "matriks-rtd.mjs");
    const startDde = () => {
      if (shuttingDown) return;
      const next = spawn(process.execPath, [ddeScript, ddeFile], { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
      ddeProcess = next;
      retryTunnelAfterFailure(next, (kind, detail) => {
        if (shuttingDown) return;
        if (ddeProcess === next) ddeProcess = null;
        console.error(`[matriks] RTD bridge ${kind} (${detail}); retrying`);
        startDde();
      });
      console.log(`[matriks] RTD auto-connect enabled (${ddeScript})`);
    };
    startDde();
  }
  connect();
  await report();
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => { console.error(`[matriks] ${error.message}`); process.exit(1); });
