#!/usr/bin/env node
// Guarded MatriksIQ order client. Dry-run is the default; live submission needs
// both MATRIKS_ORDER_LIVE=1 and an exact --confirm phrase.
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VT = "\x0b";
const MAX_FRAME_BYTES = 1_000_000;

function normalizedLabel(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ıİ]/g, "i")
    .toLowerCase();
}

export function findDemoAccount(accounts, exchangeId = 4) {
  for (const brokerage of Array.isArray(accounts) ? accounts : []) {
    const name = normalizedLabel(brokerage?.BrokageName ?? brokerage?.BrokerageName);
    if (!name.includes("matriks deneme ortami")) continue;
    for (const account of Array.isArray(brokerage?.AccountIdList) ? brokerage.AccountIdList : []) {
      const currentExchange = Number(account?.ExchangeId ?? account?.ExchangeID);
      if (currentExchange !== Number(exchangeId)) continue;
      const accountId = String(account?.AccountId ?? account?.AccountID ?? "").trim();
      const brokerageId = String(brokerage?.BrokageId ?? brokerage?.BrokerageId ?? "").trim();
      if (accountId && brokerageId) return {
        brokerageId,
        brokerageName: String(brokerage?.BrokageName ?? brokerage?.BrokerageName ?? ""),
        accountId,
        exchangeId: currentExchange,
      };
    }
  }
  return null;
}

function loadEnv(file = path.resolve(".env.matriks")) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || match[2].startsWith("#") || process.env[match[1]]) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function requiredText(value, name, max = 128) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${name} is required and must be at most ${max} characters`);
  return text;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

function normalizeSymbol(value) {
  const symbol = requiredText(value, "symbol", 32).toUpperCase();
  if (!/^[A-Z0-9_. -]+$/.test(symbol)) throw new Error("symbol contains unsupported characters");
  return symbol;
}

function digitCode(value, name, fallback) {
  const code = String(value ?? fallback);
  if (!/^\d$/.test(code)) throw new Error(`${name} must be a single digit code`);
  return code;
}

export function createNewOrder({
  brokerageId,
  accountId,
  symbol,
  side,
  quantity,
  price,
  clientOrderId = String(Date.now()).padStart(20, "0"),
  orderType = "2",
  timeInForce = "0",
  transactionType = "1",
  includeAfterSession = false,
}) {
  const normalizedSide = String(side ?? "").trim().toLowerCase();
  if (normalizedSide !== "buy" && normalizedSide !== "sell") throw new Error("side must be buy or sell");
  const orderQuantity = positiveNumber(quantity, "quantity");
  const orderPrice = positiveNumber(price, "price");
  const qty = normalizedSide === "buy" || normalizedSide === "sell" ? orderQuantity : 0;

  return {
    OrderSide: normalizedSide === "buy" ? 1 : 2,
    OrderID: null,
    OrderID2: null,
    ClientOrderID: requiredText(clientOrderId, "clientOrderId", 64),
    OrderQty: qty,
    OrdStatus: "0",
    LeavesQty: qty,
    FilledQty: 0,
    AvgPx: 0,
    TradeDate: "0001-01-01T00:00:00",
    TransactTime: "00:00:00",
    StopPx: 0,
    Explanation: null,
    ExpireDate: "0001-01-01T00:00:00",
    Symbol: normalizeSymbol(symbol),
    Price: orderPrice,
    Quantity: orderQuantity,
    IncludeAfterSession: Boolean(includeAfterSession),
    TimeInForce: digitCode(timeInForce, "time-in-force", "0"),
    OrderType: digitCode(orderType, "order-type", "2"),
    TransactionType: digitCode(transactionType, "transaction-type", "1"),
    AccountId: requiredText(accountId, "accountId", 128),
    BrokageId: requiredText(brokerageId, "brokerageId", 64),
    ApiCommands: 3,
  };
}

export function encodeOrderPacket(packet) {
  if (!packet || packet.ApiCommands !== 3) throw new Error("Only new-order packets are supported by this client");
  return `${JSON.stringify(packet)}${VT}`;
}

function decodeFrames(onPacket, onError = () => undefined) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      buffer = "";
      onError(new Error("Matriks response exceeded 1 MB"));
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
  };
}

export function requestMatriks({ host = "127.0.0.1", port = 18890, packet, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Matriks API timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error("Matriks API socket timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write("SetMessageType0");
      socket.write(`${JSON.stringify(packet)}${VT}`);
    });
    const push = decodeFrames((response) => {
      clearTimeout(timer);
      finish(null, response);
    }, (error) => finish(error));
    socket.on("data", push);
    socket.once("close", () => {
      clearTimeout(timer);
      if (!settled) finish(new Error("Matriks API disconnected before responding"));
    });
  });
}

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replaceAll("-", "_");
    if (key === "accounts" || key === "live" || key === "test_order" || key === "include_after_session" || key === "help") args[key] = true;
    else {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key.replaceAll("_", "-")}`);
      args[key] = value;
    }
  }
  return args;
}

function usage() {
  console.log("Accounts: npm run matriks:order -- --accounts");
  console.log("Dry run: npm run matriks:order -- --symbol GARAN --side buy --quantity 1 --price 100 --brokerage 7 --account '0~123'");
  console.log("Live:    set MATRIKS_ORDER_LIVE=1; npm run matriks:order -- --live --confirm 'GARAN BUY 1 100' --symbol GARAN --side buy --quantity 1 --price 100 --brokerage 7 --account '0~123'");
  console.log("Demo:    set MATRIKS_TEST_ORDER=1; npm run matriks:order -- --test-order --live --confirm 'TEST GARAN BUY 1 100' --symbol GARAN --side buy --quantity 1 --price 100");
}

async function main() {
  loadEnv();
  const args = readArgs(process.argv.slice(2));
  if (args.help || (!args.accounts && !args.symbol && !args.test_order)) { usage(); return; }

  const host = String(args.host || process.env.MATRIKS_HOST || "127.0.0.1");
  const port = Number(args.port || process.env.MATRIKS_PORT || 18890);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");

  if (args.accounts) {
    const response = await requestMatriks({ host, port, packet: { ApiCommands: 0 } });
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  let demoAccount = null;
  if (args.test_order) {
    const response = await requestMatriks({ host, port, packet: { ApiCommands: 0 } });
    demoAccount = findDemoAccount(response?.Accounts, Number(args.exchange_id || 4));
    if (!demoAccount) {
      throw new Error("No [Matriks Deneme Ortamı] account is logged in; refusing to send a test order");
    }
  }

  const packet = createNewOrder({
    brokerageId: args.brokerage || demoAccount?.brokerageId,
    accountId: args.account || demoAccount?.accountId,
    symbol: args.symbol,
    side: args.side,
    quantity: args.quantity,
    price: args.price,
    orderType: args.order_type,
    timeInForce: args.time_in_force,
    transactionType: args.transaction_type,
    includeAfterSession: args.include_after_session,
  });

  if (!args.live) {
    console.log(JSON.stringify({ mode: "dry-run", ...(demoAccount ? { demoAccount } : {}), packet }, null, 2));
    console.log(args.test_order
      ? "No order was sent. Add --live, MATRIKS_TEST_ORDER=1, and the exact TEST --confirm phrase to submit."
      : "No order was sent. Add --live, MATRIKS_ORDER_LIVE=1, and the exact --confirm phrase to submit.");
    return;
  }

  if (args.test_order) {
    if (process.env.MATRIKS_TEST_ORDER !== "1") throw new Error("Test orders are disabled; set MATRIKS_TEST_ORDER=1 explicitly");
  } else if (process.env.MATRIKS_ORDER_LIVE !== "1") {
    throw new Error("Live orders are disabled; set MATRIKS_ORDER_LIVE=1 explicitly");
  }
  const expected = `${args.test_order ? "TEST " : ""}${packet.Symbol} ${packet.OrderSide === 1 ? "BUY" : "SELL"} ${packet.Quantity} ${packet.Price}`;
  if (args.confirm !== expected) throw new Error(`Confirmation must exactly equal: ${expected}`);

  console.error(`[matriks] submitting ${expected}`);
  const response = await requestMatriks({ host, port, packet });
  console.log(JSON.stringify(response, null, 2));
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => { console.error(`[matriks] ${error.message}`); process.exit(1); });
