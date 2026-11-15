import http from "node:http";
import net from "node:net";

const appServerPort = Number(process.env.OPENLEEK_SANDBOX_APP_SERVER_PORT ?? "4500");
const healthPort = Number(process.env.OPENLEEK_SANDBOX_HEALTH_PORT ?? "4501");

function appServerReachable() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: appServerPort });
    const finish = (reachable) => { socket.destroy(); resolve(reachable); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

http.createServer(async (request, response) => {
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const reachable = await appServerReachable();
  response.writeHead(reachable ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: reachable ? "ok" : "starting" }));
}).listen(healthPort, "0.0.0.0");
