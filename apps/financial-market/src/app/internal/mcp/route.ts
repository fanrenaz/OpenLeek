import { financialMarketRevisionService } from "../../../server/runtime";
import { financialAcknowledgement, financialRequestIdentity, publicFinancialMcpError } from "../../../application/mcp-write-presentation";

export const runtime = "nodejs";

const tools = [
  ["get_quote", "Returns the symbol, last traded price, best bid and ask prices, and displayed size at each best price.", {}],
  ["get_order_book", "Returns aggregated bid and ask price levels, including total quantity and order count at each price.", {
    depth: { type: "integer", minimum: 1, maximum: 50, description: "Maximum number of price levels to return on each side. Defaults to 10." },
  }],
  ["get_candles", "Returns historical open, high, low, close, and volume values for consecutive market periods.", {
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of candles to return. Defaults to 20." },
  }],
  ["list_market_trades", "Returns anonymous individual market trades in execution order.", {
    roundId: { type: "integer", minimum: 0, description: "Market period to include. When omitted, trades from all available periods are returned." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of trades to return. Defaults to 100." },
    offset: { type: "integer", minimum: 0, description: "Number of matching trades to skip. Defaults to 0." },
  }],
  ["list_market_orders", "Returns anonymous individual active limit orders in creation order.", {
    side: { type: "string", enum: ["buy", "sell"], description: "Order side to include." },
    limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum number of orders to return. Defaults to 100." },
    offset: { type: "integer", minimum: 0, description: "Number of matching orders to skip. Defaults to 0." },
  }],
  ["get_account", "Returns the authenticated account's cash balance, position, reserved cash, and reserved position.", {}],
  ["list_orders", "Returns the authenticated account's orders with optional status, side, and order-type filters.", {
    status: { type: "string", enum: ["open", "filled", "cancelled", "expired", "replaced"], description: "Order status to include." },
    side: { type: "string", enum: ["buy", "sell"], description: "Order side to include." },
    orderType: { type: "string", enum: ["limit", "market"], description: "Order type to include." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of orders to return. Defaults to 50." },
    offset: { type: "integer", minimum: 0, description: "Number of matching orders to skip. Defaults to 0." },
  }],
  ["list_executions", "Returns the authenticated account's completed fills in newest-first pages, including order, side, quantity, price, liquidity role, and counterparty type.", {
    orderId: { type: "string", description: "Order identifier to filter fills by." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of fills to return. Defaults to 10." },
    cursor: { type: "string", description: "Pagination cursor returned by a previous call." },
  }],
  ["preview_order", "Returns a non-binding fill and notional estimate without placing an order or reserving funds.", {
    side: { type: "string", enum: ["buy", "sell"], description: "Order side." },
    orderType: { type: "string", enum: ["limit", "market"], description: "Order type." },
    quantity: { type: "integer", minimum: 1, description: "Exact whole-unit order quantity. Mutually exclusive with cashAmount and fraction." },
    cashAmount: { type: "number", exclusiveMinimum: 0, description: "Cash amount in currency units. Mutually exclusive with quantity and fraction." },
    fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of available cash for a buy or available position for a sell. Mutually exclusive with quantity and cashAmount." },
    limitPrice: { type: "number", exclusiveMinimum: 0, description: "Limit price in currency units, aligned to the instrument tickSize. Required for a limit order and omitted for a market order." },
  }],
  ["place_order", "Submits a whole-unit limit order.", {
    side: { type: "string", enum: ["buy", "sell"], description: "Order side." },
    quantity: { type: "integer", minimum: 1, description: "Exact whole-unit order quantity." },
    limitPrice: { type: "number", exclusiveMinimum: 0, description: "Limit price in currency units, aligned to the instrument tickSize." },
    timeInForce: { type: "string", enum: ["gtc", "ioc", "fok"], description: "Order time-in-force. Defaults to gtc." },
    ttlRounds: { type: "integer", minimum: 1, description: "Number of market periods after which an open order expires." },
    rationale: { type: "string", maxLength: 2000, description: "Optional audit note stored with the command. It does not affect order processing." },
  }],
  ["place_limit_order", "Submits a limit order sized by whole-unit quantity, cash amount, or account fraction.", {
    side: { type: "string", enum: ["buy", "sell"], description: "Order side." },
    quantity: { type: "integer", minimum: 1, description: "Exact whole-unit order quantity. Mutually exclusive with cashAmount and fraction." },
    cashAmount: { type: "number", exclusiveMinimum: 0, description: "Cash amount in currency units. Mutually exclusive with quantity and fraction." },
    fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of available cash for a buy or available position for a sell. Mutually exclusive with quantity and cashAmount." },
    limitPrice: { type: "number", exclusiveMinimum: 0, description: "Limit price in currency units, aligned to the instrument tickSize." },
    timeInForce: { type: "string", enum: ["gtc", "ioc", "fok"], description: "Order time-in-force. Defaults to gtc." },
    ttlRounds: { type: "integer", minimum: 1, description: "Number of market periods after which an open order expires." },
    rationale: { type: "string", maxLength: 2000, description: "Optional audit note stored with the command. It does not affect order processing." },
  }],
  ["place_market_order", "Submits an unpriced IOC or FOK market order sized by whole-unit quantity, cash amount, or account fraction.", {
    side: { type: "string", enum: ["buy", "sell"], description: "Order side." },
    quantity: { type: "integer", minimum: 1, description: "Exact whole-unit order quantity. Mutually exclusive with cashAmount and fraction." },
    cashAmount: { type: "number", exclusiveMinimum: 0, description: "Cash amount in currency units. Mutually exclusive with quantity and fraction." },
    fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of available cash for a buy or available position for a sell. Mutually exclusive with quantity and cashAmount." },
    timeInForce: { type: "string", enum: ["ioc", "fok"], description: "Market-order time-in-force." },
    rationale: { type: "string", maxLength: 2000, description: "Optional audit note stored with the command. It does not affect order processing." },
  }],
  ["replace_order", "Atomically replaces an open limit order with a new limit order.", {
    orderId: { type: "string", description: "Identifier of the open limit order being replaced." },
    side: { type: "string", enum: ["buy", "sell"], description: "Replacement order side." },
    quantity: { type: "integer", minimum: 1, description: "Exact whole-unit replacement quantity. Mutually exclusive with cashAmount and fraction." },
    cashAmount: { type: "number", exclusiveMinimum: 0, description: "Cash amount in currency units. Mutually exclusive with quantity and fraction." },
    fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "Fraction of available cash for a buy or available position for a sell. Mutually exclusive with quantity and cashAmount." },
    limitPrice: { type: "number", exclusiveMinimum: 0, description: "Replacement limit price in currency units, aligned to the instrument tickSize." },
    timeInForce: { type: "string", enum: ["gtc", "ioc", "fok"], description: "Replacement order time-in-force. Defaults to gtc." },
    ttlRounds: { type: "integer", minimum: 1, description: "Number of market periods after which the replacement order expires." },
    rationale: { type: "string", maxLength: 2000, description: "Optional audit note stored with the command. It does not affect order processing." },
  }],
  ["cancel_order", "Submits cancellation of an open order owned by the authenticated account.", {
    orderId: { type: "string", description: "Identifier of the open order being cancelled." },
  }],
] as const;

interface McpRequest {
  id?: string | number;
  method?: string;
  params?: { name?: string; uri?: string; arguments?: Record<string, unknown> };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as McpRequest | null;
  if (!body?.method) return rpcError(null, -32600, "invalid request", 400);
  const id = body.id ?? null;
  try {
    const bearerToken = bearer(request.headers.get("authorization"));
    if (!bearerToken) return rpcError(id, -32602, "missing Financial bearer credential");
    const service = await financialMarketRevisionService();
    await service.assertMcpAccess(bearerToken);
    if (body.method === "initialize") {
      return rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { resources: { listChanged: false }, tools: {} },
        serverInfo: { name: "openleek-financial-market", version: "1.0.0" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "resources/list") return rpcResult(id, { resources: await service.listMcpResources(bearerToken) });
    if (body.method === "resources/read") {
      const uri = body.params?.uri;
      if (!uri) return rpcError(id, -32602, "resources/read requires uri");
      const resource = await service.readMcpResource(bearerToken, uri);
      return rpcResult(id, { contents: [{ uri, mimeType: resource.mimeType, text: resource.text }] });
    }
    if (body.method === "tools/list") {
      const allowed = new Set(await service.listMcpTools(bearerToken));
      return rpcResult(id, {
        tools: tools.filter(([name]) => allowed.has(name)).map(([name, description, properties]) => ({
          name,
          description,
          inputSchema: { type: "object", properties, additionalProperties: false },
        })),
      });
    }
    if (body.method !== "tools/call") return rpcError(id, -32601, "method not found");
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (["get_quote", "get_order_book", "get_candles", "list_market_trades", "list_market_orders", "get_account", "list_orders", "list_executions", "preview_order"].includes(name ?? "")) {
      return toolResult(id, await service.callMcpQuery({ bearerToken, name: name!, arguments: args }));
    }
    if (name === "place_order") {
      await service.enqueueMcpOrder({
        bearerToken,
        invocationId: financialRequestIdentity(body.id),
        side: side(args.side),
        quantity: positiveInteger(args.quantity, "quantity"),
        limitPrice: positiveNumber(args.limitPrice, "limitPrice"),
        ...(args.timeInForce === undefined ? {} : { timeInForce: timeInForce(args.timeInForce) }),
        ...(args.ttlRounds === undefined ? {} : { ttlRounds: positiveInteger(args.ttlRounds, "ttlRounds") }),
        ...(args.rationale === undefined ? {} : { rationale: text(args.rationale, "rationale") }),
      });
      return toolTextResult(id, financialAcknowledgement(name));
    }
    if (name === "place_limit_order") {
      await service.enqueueMcpLimitOrder({
        bearerToken,
        invocationId: financialRequestIdentity(body.id),
        side: side(args.side),
        ...sizing(args),
        limitPrice: positiveNumber(args.limitPrice, "limitPrice"),
        ...(args.timeInForce === undefined ? {} : { timeInForce: timeInForce(args.timeInForce) }),
        ...(args.ttlRounds === undefined ? {} : { ttlRounds: positiveInteger(args.ttlRounds, "ttlRounds") }),
        ...(args.rationale === undefined ? {} : { rationale: text(args.rationale, "rationale") }),
      });
      return toolTextResult(id, financialAcknowledgement(name));
    }
    if (name === "place_market_order") {
      await service.enqueueMcpMarketOrder({
        bearerToken,
        invocationId: financialRequestIdentity(body.id),
        side: side(args.side),
        ...sizing(args),
        timeInForce: marketTimeInForce(args.timeInForce),
        ...(args.rationale === undefined ? {} : { rationale: text(args.rationale, "rationale") }),
      });
      return toolTextResult(id, financialAcknowledgement(name));
    }
    if (name === "replace_order") {
      await service.enqueueMcpReplacement({
        bearerToken,
        invocationId: financialRequestIdentity(body.id),
        orderId: text(args.orderId, "orderId"),
        side: side(args.side),
        ...sizing(args),
        limitPrice: positiveNumber(args.limitPrice, "limitPrice"),
        ...(args.timeInForce === undefined ? {} : { timeInForce: timeInForce(args.timeInForce) }),
        ...(args.ttlRounds === undefined ? {} : { ttlRounds: positiveInteger(args.ttlRounds, "ttlRounds") }),
        ...(args.rationale === undefined ? {} : { rationale: text(args.rationale, "rationale") }),
      });
      return toolTextResult(id, financialAcknowledgement(name));
    }
    if (name === "cancel_order") {
      await service.enqueueMcpCancellation({
        bearerToken,
        invocationId: financialRequestIdentity(body.id),
        orderId: text(args.orderId, "orderId"),
      });
      return toolTextResult(id, financialAcknowledgement(name));
    }
    return rpcError(id, -32602, "unknown Financial tool");
  } catch (error) {
    return rpcError(id, -32000, publicFinancialMcpError(body.params?.name, error));
  }
}

function toolResult(id: string | number | null, value: unknown) {
  return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
}

function toolTextResult(id: string | number | null, text: string) {
  return rpcResult(id, { content: [{ type: "text", text }] });
}

function rpcResult(id: string | number | null, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a finite positive number`);
  return value;
}

function side(value: unknown): "buy" | "sell" {
  if (value !== "buy" && value !== "sell") throw new Error("side must be buy or sell");
  return value;
}

function timeInForce(value: unknown): "gtc" | "ioc" | "fok" {
  if (value !== "gtc" && value !== "ioc" && value !== "fok") throw new Error("timeInForce must be gtc, ioc, or fok");
  return value;
}

function marketTimeInForce(value: unknown): "ioc" | "fok" {
  if (value !== "ioc" && value !== "fok") throw new Error("timeInForce must be ioc or fok");
  return value;
}

function sizing(args: Record<string, unknown>): { quantity?: number; cashAmount?: number; fraction?: number } {
  const supplied = [args.quantity, args.cashAmount, args.fraction].filter((value) => value !== undefined);
  if (supplied.length !== 1) throw new Error("exactly one of quantity, cashAmount, or fraction is required");
  if (args.quantity !== undefined) return { quantity: positiveInteger(args.quantity, "quantity") };
  if (args.cashAmount !== undefined) return { cashAmount: positiveNumber(args.cashAmount, "cashAmount") };
  if (typeof args.fraction !== "number" || !Number.isFinite(args.fraction) || args.fraction <= 0 || args.fraction > 1) {
    throw new Error("fraction must be greater than 0 and at most 1");
  }
  return { fraction: args.fraction };
}

function bearer(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
