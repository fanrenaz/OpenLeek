import { createFinancialMarketAppRouter } from "../../../../../server/router";
export const runtime = "nodejs";
export async function GET() { return Response.json(await createFinancialMarketAppRouter().createCaller({}).contextPlugin.descriptor({})); }
