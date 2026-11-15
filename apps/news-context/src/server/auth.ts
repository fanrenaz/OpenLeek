export function authorized(request: Request) { const token = process.env.OPENLEEK_CONTEXT_BEARER_TOKEN; return Boolean(token && request.headers.get("authorization") === `Bearer ${token}`); }
