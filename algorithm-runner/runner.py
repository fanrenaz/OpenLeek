"""Credentialless Python 3.12 execution boundary for OpenLeek published algorithms.

The caller sends published code and control metadata; Context history remains
behind a parent-owned, capability-bound proxy. This process never mounts a
Context database, Redis, Docker socket, Experiment secret, or host filesystem.
Every request runs in a short-lived isolated child with a fixed import allow-list.
"""

from __future__ import annotations

import ast
import json
import os
import socket
import subprocess
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from observability import observe_request, setup_observability

MAX_BODY_BYTES = 512 * 1024
MAX_RUNTIME_MS = 60_000
MAX_MEMORY_MB = 1_024
MAX_HISTORY_RESPONSE_BYTES = 4 * 1024 * 1024
ALLOWED_IMPORTS = {
    "math", "statistics", "random", "json", "collections", "itertools", "functools", "datetime",
    "numpy", "networkx", "scipy", "pandas", "sklearn",
}
FORBIDDEN_CALLS = {
    "open", "exec", "eval", "compile", "input", "__import__", "globals", "locals", "vars",
    "getattr", "setattr", "delattr", "breakpoint", "help", "quit", "exit",
}

CHILD_PROGRAM = r'''
import builtins, hashlib, inspect, json, os, random, socket, sys, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

allowed_imports = set(json.loads(sys.stdin.readline()))
payload = json.loads(sys.stdin.readline())
history_fd = int(sys.argv[1]) if len(sys.argv) > 1 else -1

def allowed_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in allowed_imports:
        raise ImportError(f"import is not available to feed algorithms: {name}")
    return builtins.__import__(name, globals, locals, fromlist, level)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "filter": filter, "float": float, "int": int, "isinstance": isinstance, "len": len,
    "list": list, "map": map, "max": max, "min": min, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum, "tuple": tuple,
    "zip": zip, "Exception": Exception, "ValueError": ValueError, "__build_class__": __build_class__,
    "__import__": allowed_import,
}
namespace = {"__builtins__": safe_builtins, "__name__": "feed_algorithm"}
exec(compile(payload["source"], "published_feed_algorithm.py", "exec"), namespace, namespace)
algorithm_class = namespace.get("FeedAlgorithm")
if not isinstance(algorithm_class, type):
    raise TypeError("FeedAlgorithm class must be defined")
schema = getattr(algorithm_class, "CONFIG_SCHEMA", None)
default_config = getattr(algorithm_class, "DEFAULT_CONFIG", None)
if not isinstance(schema, dict):
    raise TypeError("FeedAlgorithm.CONFIG_SCHEMA must be a dict")
if not isinstance(default_config, dict):
    raise TypeError("FeedAlgorithm.DEFAULT_CONFIG must be a dict")

def context_for(seed, round_id, feed_size, social_history):
    def rng_for(actor_id):
        if not isinstance(actor_id, str):
            raise TypeError("rng_for requires a string actor_id")
        digest = hashlib.sha256(f"{seed}:{actor_id}".encode()).digest()
        return random.Random(int.from_bytes(digest, "big"))

    return {
        "seed": seed,
        "roundId": round_id,
        "feedSize": feed_size,
        "rng_for": rng_for,
        "socialHistory": social_history,
    }

class UnavailableSocialHistory:
    def _unavailable(self):
        raise RuntimeError("socialHistory is not available during validation")

    def all(self):
        return self._unavailable()

    def round(self, round_id):
        return self._unavailable()

class SocialHistory:
    def __init__(self, fd):
        if fd < 0:
            raise RuntimeError("socialHistory RPC is unavailable")
        self._socket = socket.socket(fileno=fd)
        self._reader = self._socket.makefile("r", encoding="utf-8")
        self._writer = self._socket.makefile("w", encoding="utf-8")
        self._next_id = 1
        # rank() calls are parallel, but each socket request/response exchange
        # must remain atomic so a caller cannot receive another caller's page.
        self._lock = threading.Lock()

    def _call(self, method, args):
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            self._writer.write(json.dumps({"id": request_id, "method": method, "args": args}, separators=(",", ":")) + "\n")
            self._writer.flush()
            line = self._reader.readline()
        if not line:
            raise RuntimeError("socialHistory RPC disconnected")
        response = json.loads(line)
        if not isinstance(response, dict) or response.get("id") != request_id:
            raise RuntimeError("socialHistory RPC returned an invalid response")
        if response.get("ok") is not True:
            raise RuntimeError(response.get("error") if isinstance(response.get("error"), str) else "socialHistory RPC failed")
        return response.get("result")

    def all(self):
        cursor = None
        seen_cursors = set()
        while True:
            result = self._call("all", {} if cursor is None else {"cursor": cursor})
            if not isinstance(result, dict) or not isinstance(result.get("records"), list):
                raise RuntimeError("socialHistory.all returned an invalid page")
            for record in result["records"]:
                yield record
            next_cursor = result.get("nextCursor")
            if next_cursor is None:
                return
            if not isinstance(next_cursor, str) or not next_cursor:
                raise RuntimeError("socialHistory.all returned an invalid cursor")
            if next_cursor in seen_cursors:
                raise RuntimeError("socialHistory.all returned a repeated cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def round(self, round_id):
        if not isinstance(round_id, int) or isinstance(round_id, bool) or round_id < 0:
            raise TypeError("socialHistory.round requires a non-negative integer roundId")
        result = self._call("round", {"roundId": round_id})
        if not isinstance(result, dict) or "record" not in result:
            raise RuntimeError("socialHistory.round returned an invalid response")
        return result["record"]

def build_algorithm(config, context):
    constructor = inspect.signature(algorithm_class)
    parameters = list(constructor.parameters.values())
    if len(parameters) != 2 or any(parameter.kind not in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD) for parameter in parameters):
        raise TypeError("FeedAlgorithm constructor must be FeedAlgorithm(config, context)")
    algorithm = algorithm_class(config, context)
    rank = getattr(algorithm, "rank", None)
    if not callable(rank):
        raise TypeError("FeedAlgorithm.rank(actor_id) must be defined")
    rank_parameters = list(inspect.signature(rank).parameters.values())
    if len(rank_parameters) != 1 or rank_parameters[0].kind not in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
        raise TypeError("FeedAlgorithm.rank must accept exactly one actor_id parameter")
    return algorithm, rank

if payload["mode"] == "validate":
    build_algorithm(default_config, context_for("validation", 0, 1, UnavailableSocialHistory()))
    print(json.dumps({"valid": True, "configSchema": schema, "defaultConfig": default_config}, separators=(",", ":")))
else:
    algorithm, rank = build_algorithm(
        payload["config"],
        context_for(payload["seed"], payload["roundId"], payload["feedSize"], SocialHistory(history_fd)),
    )
    actor_ids = payload["actorIds"]
    feed_size = payload["feedSize"]
    workers = max(1, min(len(actor_ids), max(1, os.cpu_count() or 1), 8))
    ranked_post_ids = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(rank, actor_id): actor_id for actor_id in actor_ids}
        for future in as_completed(futures):
            actor_id = futures[future]
            try:
                post_ids = future.result()
            except Exception as error:
                raise RuntimeError(f"FeedAlgorithm.rank({actor_id}) failed: {error}") from error
            if not isinstance(post_ids, list) or not all(isinstance(post_id, str) for post_id in post_ids):
                raise TypeError(f"FeedAlgorithm.rank({actor_id}) must return list[str]")
            if len(post_ids) > feed_size:
                raise ValueError(f"FeedAlgorithm.rank({actor_id}) returned more than feedSize post IDs")
            if len(set(post_ids)) != len(post_ids):
                raise ValueError(f"FeedAlgorithm.rank({actor_id}) returned duplicate post IDs")
            ranked_post_ids[actor_id] = post_ids
    print(json.dumps({"feeds": [{"actorId": actor_id, "postIds": ranked_post_ids[actor_id]} for actor_id in actor_ids]}, separators=(",", ":")))
'''


# Market maker source deliberately runs in a different child program from the
# established FeedAlgorithm contract.  The only way it can reach Financial
# history is a socketpair passed by the parent.  Neither the opaque capability
# nor the endpoint are serialized into this program's input.
MARKET_MAKER_CHILD_PROGRAM = r'''
import builtins, inspect, json, socket, sys, threading

allowed_imports = set(json.loads(sys.stdin.readline()))
payload = json.loads(sys.stdin.readline())
history_fd = int(sys.argv[1]) if len(sys.argv) > 1 else -1

def allowed_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in allowed_imports:
        raise ImportError(f"import is not available to market makers: {name}")
    return builtins.__import__(name, globals, locals, fromlist, level)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "filter": filter, "float": float, "int": int, "isinstance": isinstance, "len": len,
    "list": list, "map": map, "max": max, "min": min, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum, "tuple": tuple,
    "zip": zip, "Exception": Exception, "RuntimeError": RuntimeError, "TypeError": TypeError,
    "ValueError": ValueError, "__build_class__": __build_class__, "__import__": allowed_import,
}
namespace = {"__builtins__": safe_builtins, "__name__": "market_maker"}
exec(compile(payload["source"], "published_market_maker.py", "exec"), namespace, namespace)
market_maker_class = namespace.get("MarketMaker")
if not isinstance(market_maker_class, type):
    raise TypeError("MarketMaker class must be defined")
schema = getattr(market_maker_class, "CONFIG_SCHEMA", None)
default_config = getattr(market_maker_class, "DEFAULT_CONFIG", None)
if not isinstance(schema, dict):
    raise TypeError("MarketMaker.CONFIG_SCHEMA must be a dict")
if not isinstance(default_config, dict):
    raise TypeError("MarketMaker.DEFAULT_CONFIG must be a dict")

class UnavailableFinancialHistory:
    def _unavailable(self):
        raise RuntimeError("financialHistory is not available during validation")

    def all(self):
        return self._unavailable()

    def round(self, round_id):
        return self._unavailable()

    def makerAccount(self):
        return self._unavailable()

    def participantBaseline(self):
        return self._unavailable()

class FinancialHistory:
    def __init__(self, fd):
        if fd < 0:
            raise RuntimeError("financialHistory RPC is unavailable")
        self._socket = socket.socket(fileno=fd)
        self._reader = self._socket.makefile("r", encoding="utf-8")
        self._writer = self._socket.makefile("w", encoding="utf-8")
        self._next_id = 1
        self._lock = threading.Lock()

    def _call(self, method, args):
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            self._writer.write(json.dumps({"id": request_id, "method": method, "args": args}, separators=(",", ":")) + "\n")
            self._writer.flush()
            line = self._reader.readline()
        if not line:
            raise RuntimeError("financialHistory RPC disconnected")
        response = json.loads(line)
        if not isinstance(response, dict) or response.get("id") != request_id:
            raise RuntimeError("financialHistory RPC returned an invalid response")
        if response.get("ok") is not True:
            raise RuntimeError(response.get("error") if isinstance(response.get("error"), str) else "financialHistory RPC failed")
        return response.get("result")

    def all(self):
        cursor = None
        seen_cursors = set()
        while True:
            result = self._call("all", {} if cursor is None else {"cursor": cursor})
            if not isinstance(result, dict) or not isinstance(result.get("records"), list):
                raise RuntimeError("financialHistory.all returned an invalid page")
            for record in result["records"]:
                yield record
            next_cursor = result.get("nextCursor")
            if next_cursor is None:
                return
            if not isinstance(next_cursor, str) or not next_cursor:
                raise RuntimeError("financialHistory.all returned an invalid cursor")
            if next_cursor in seen_cursors:
                raise RuntimeError("financialHistory.all returned a repeated cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor

    def round(self, round_id):
        if not isinstance(round_id, int) or isinstance(round_id, bool) or round_id < 0:
            raise TypeError("financialHistory.round requires a non-negative integer roundId")
        result = self._call("round", {"roundId": round_id})
        if not isinstance(result, dict) or "record" not in result:
            raise RuntimeError("financialHistory.round returned an invalid response")
        return result["record"]

    def makerAccount(self):
        result = self._call("makerAccount", {})
        if not isinstance(result, dict) or "account" not in result:
            raise RuntimeError("financialHistory.makerAccount returned an invalid response")
        return result["account"]

    def participantBaseline(self):
        result = self._call("participantBaseline", {})
        if not isinstance(result, dict) or "baseline" not in result:
            raise RuntimeError("financialHistory.participantBaseline returned an invalid response")
        return result["baseline"]

def build_market_maker(config, context):
    constructor = inspect.signature(market_maker_class)
    parameters = list(constructor.parameters.values())
    if len(parameters) != 2 or any(parameter.kind not in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD) for parameter in parameters):
        raise TypeError("MarketMaker constructor must be MarketMaker(config, context)")
    market_maker = market_maker_class(config, context)
    quote = getattr(market_maker, "quote", None)
    if not callable(quote):
        raise TypeError("MarketMaker.quote() must be defined")
    quote_parameters = list(inspect.signature(quote).parameters.values())
    if quote_parameters:
        raise TypeError("MarketMaker.quote must not accept arguments")
    return quote

def valid_positive_tick(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0

def valid_positive_price(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value < float("inf")

def normalize_orders(value):
    if not isinstance(value, list):
        raise TypeError("MarketMaker.quote() must return a list of order intents")
    normalized = []
    for index, order in enumerate(value):
        if not isinstance(order, dict) or set(order) != {"side", "limitPrice", "quantity"}:
            raise TypeError(f"MarketMaker.quote() order {index} must contain exactly side, limitPrice, quantity")
        if order["side"] not in {"buy", "sell"}:
            raise ValueError(f"MarketMaker.quote() order {index} has an invalid side")
        if not valid_positive_price(order["limitPrice"]) or not valid_positive_tick(order["quantity"]):
            raise ValueError(f"MarketMaker.quote() order {index} requires a finite positive price and positive integer quantity")
        normalized.append({"side": order["side"], "limitPrice": order["limitPrice"], "quantity": order["quantity"]})
    return normalized

if payload["mode"] == "validate":
    build_market_maker(default_config, {
        "seed": "validation",
        "roundId": 0,
        "timing": "opening",
        "financialHistory": UnavailableFinancialHistory(),
    })
    print(json.dumps({"valid": True, "configSchema": schema, "defaultConfig": default_config}, separators=(",", ":")))
else:
    quote = build_market_maker(payload["config"], {
        "seed": payload["seed"],
        "roundId": payload["roundId"],
        "timing": payload["timing"],
        "financialHistory": FinancialHistory(history_fd),
    })
    print(json.dumps({"orders": normalize_orders(quote())}, separators=(",", ":")))
'''


# Population and Network generators are intentionally source-compatible with
# the existing runner confinement, but have no history proxy at all.  Their
# only input is experiment seed plus static generation context; they cannot
# choose canonical IDs or observe a live Context.
WORLD_GENERATOR_CHILD_PROGRAM = r'''
import builtins, inspect, json, sys

allowed_imports = set(json.loads(sys.stdin.readline()))
payload = json.loads(sys.stdin.readline())

def allowed_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level != 0 or root not in allowed_imports:
        raise ImportError(f"import is not available to world generators: {name}")
    return builtins.__import__(name, globals, locals, fromlist, level)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict, "enumerate": enumerate,
    "filter": filter, "float": float, "int": int, "isinstance": isinstance, "len": len,
    "list": list, "map": map, "max": max, "min": min, "range": range, "reversed": reversed,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum, "tuple": tuple,
    "zip": zip, "Exception": Exception, "RuntimeError": RuntimeError, "TypeError": TypeError,
    "ValueError": ValueError, "__build_class__": __build_class__, "__import__": allowed_import,
}
namespace = {"__builtins__": safe_builtins, "__name__": "world_generator"}
exec(compile(payload["source"], "published_world_generator.py", "exec"), namespace, namespace)
kind = payload["kind"]
class_name = "PopulationGenerator" if kind == "population" else "NetworkGenerator"
generator_class = namespace.get(class_name)
if not isinstance(generator_class, type):
    raise TypeError(f"{class_name} class must be defined")
schema = getattr(generator_class, "CONFIG_SCHEMA", None)
default_config = getattr(generator_class, "DEFAULT_CONFIG", None)
if not isinstance(schema, dict):
    raise TypeError(f"{class_name}.CONFIG_SCHEMA must be a dict")
if not isinstance(default_config, dict):
    raise TypeError(f"{class_name}.DEFAULT_CONFIG must be a dict")

def build(config, context):
    parameters = list(inspect.signature(generator_class).parameters.values())
    if len(parameters) != 2 or any(parameter.kind not in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD) for parameter in parameters):
        raise TypeError(f"{class_name} constructor must be {class_name}(config, context)")
    generator = generator_class(config, context)
    method = getattr(generator, "generate", None)
    if not callable(method):
        raise TypeError(f"{class_name}.generate() must be defined")
    if list(inspect.signature(method).parameters.values()):
        raise TypeError(f"{class_name}.generate must not accept arguments")
    return method

if payload["mode"] == "validate":
    context = {"seed": "validation", "instruments": []} if kind == "population" else {"seed": "validation", "population": []}
    build(default_config, context)
    print(json.dumps({"valid": True, "configSchema": schema, "defaultConfig": default_config}, separators=(",", ":")))
else:
    context = {"seed": payload["seed"], "instruments": payload["instruments"]} if kind == "population" else {"seed": payload["seed"], "population": payload["population"]}
    result = build(payload["config"], context)()
    if not isinstance(result, dict):
        raise TypeError(f"{class_name}.generate() must return an object")
    print(json.dumps(result, separators=(",", ":")))
'''


def error(message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST) -> tuple[int, dict[str, Any]]:
    return status, {"error": message[:4_000]}


def validate_source(source: Any, dependencies: Any, *, subject: str = "feed algorithms") -> str | None:
    if not isinstance(source, str) or not source.strip():
        return "source must be a non-empty Python string"
    if len(source) > 250_000:
        return "source exceeds 250000 characters"
    if not isinstance(dependencies, list) or not all(isinstance(item, str) and item in ALLOWED_IMPORTS for item in dependencies):
        return "dependencies must be an allow-listed list"
    try:
        tree = ast.parse(source, filename="published_feed_algorithm.py", mode="exec")
    except SyntaxError as exc:
        return f"syntax error at line {exc.lineno}: {exc.msg}"
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [name.name for name in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if (isinstance(node, ast.ImportFrom) and node.level) or any(
                name.split(".", 1)[0] not in ALLOWED_IMPORTS for name in names
            ):
                return "imports are restricted to the research-stack allow-list"
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            return f"{node.func.id} is not available to {subject}"
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            return f"dunder attribute access is not available to {subject}"
    return None


def checked_limits(value: Any) -> tuple[int, int] | str:
    if not isinstance(value, dict):
        return "limits must be an object"
    runtime = value.get("maxRuntimeMs")
    memory = value.get("maxMemoryMb")
    if not isinstance(runtime, int) or runtime < 1 or runtime > MAX_RUNTIME_MS:
        return f"maxRuntimeMs must be between 1 and {MAX_RUNTIME_MS}"
    if not isinstance(memory, int) or memory < 64 or memory > MAX_MEMORY_MB:
        return f"maxMemoryMb must be between 64 and {MAX_MEMORY_MB}"
    return runtime, memory


HistoryClient = Callable[[dict[str, str], dict[str, Any]], dict[str, Any]]
HistoryMethods = frozenset[str]


def checked_history_descriptor(value: Any, *, name: str) -> dict[str, str] | str:
    if not isinstance(value, dict):
        return f"execute requires {name} object"
    endpoint = value.get("endpoint")
    capability = value.get("capability")
    if not isinstance(endpoint, str) or not endpoint:
        return f"{name}.endpoint must be a non-empty URL"
    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
        return f"{name}.endpoint must be an absolute http(s) URL without credentials or fragments"
    if not isinstance(capability, str) or not capability:
        return f"{name}.capability must be a non-empty opaque string"
    return {"endpoint": endpoint, "capability": capability}


def history_http_client(history: dict[str, str], request: dict[str, Any]) -> dict[str, Any]:
    """Perform one parent-owned, capability-bound Context history request."""
    encoded = json.dumps(request, separators=(",", ":")).encode()
    if len(encoded) > MAX_BODY_BYTES:
        raise RuntimeError("financialHistory RPC request exceeds size limit")
    upstream = Request(
        history["endpoint"],
        data=encoded,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "authorization": f"Bearer {history['capability']}",
        },
        method="POST",
    )
    try:
        with urlopen(upstream, timeout=10) as response:
            if not 200 <= response.status < 300:
                raise RuntimeError(f"history endpoint failed ({response.status})")
            raw = response.read(MAX_HISTORY_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise RuntimeError(f"history endpoint failed ({exc.code})") from exc
    except URLError as exc:
        raise RuntimeError("history endpoint is unavailable") from exc
    if len(raw) > MAX_HISTORY_RESPONSE_BYTES:
        raise RuntimeError("history endpoint response exceeds size limit")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("history endpoint returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise RuntimeError("history endpoint returned an invalid response")
    return result


def history_response(
    method: str,
    args: Any,
    history: dict[str, str],
    client: HistoryClient,
    *,
    history_name: str,
    allowed_methods: HistoryMethods,
) -> dict[str, Any]:
    if method not in allowed_methods:
        raise RuntimeError(f"{history_name} RPC method is not allowed")
    if not isinstance(args, dict):
        raise RuntimeError(f"{history_name} RPC arguments must be an object")
    if method == "all":
        if set(args) - {"cursor"} or ("cursor" in args and (not isinstance(args["cursor"], str) or not args["cursor"])):
            raise RuntimeError(f"{history_name}.all received invalid arguments")
        result = client(history, {"operation": "all", **args})
        if not isinstance(result.get("records"), list):
            raise RuntimeError(f"{history_name} endpoint returned an invalid history page")
        next_cursor = result.get("nextCursor")
        if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
            raise RuntimeError(f"{history_name} endpoint returned an invalid history cursor")
        return {"records": result["records"], **({"nextCursor": next_cursor} if next_cursor is not None else {})}
    if method == "round":
        if set(args) != {"roundId"} or not isinstance(args["roundId"], int) or isinstance(args["roundId"], bool) or args["roundId"] < 0:
            raise RuntimeError(f"{history_name}.round received invalid arguments")
        result = client(history, {"operation": "round", "roundId": args["roundId"]})
        if "record" not in result:
            raise RuntimeError(f"{history_name} endpoint returned an invalid round response")
        return {"record": result["record"]}
    if method == "makerAccount":
        if args:
            raise RuntimeError(f"{history_name}.makerAccount received invalid arguments")
        result = client(history, {"operation": "makerAccount"})
        if "account" not in result:
            raise RuntimeError(f"{history_name} endpoint returned an invalid maker account response")
        return {"account": result["account"]}
    if method == "participantBaseline":
        if args:
            raise RuntimeError(f"{history_name}.participantBaseline received invalid arguments")
        result = client(history, {"operation": "participantBaseline"})
        if "baseline" not in result:
            raise RuntimeError(f"{history_name} endpoint returned an invalid participant baseline response")
        return {"baseline": result["baseline"]}
    raise RuntimeError(f"{history_name} RPC method is not implemented")


def serve_history_rpc(
    sock: socket.socket,
    history: dict[str, str],
    client: HistoryClient,
    stop: threading.Event,
    *,
    history_name: str,
    allowed_methods: HistoryMethods,
) -> None:
    """Relay a fixed, Context-specific history proxy until the child exits."""
    try:
        with sock, sock.makefile("r", encoding="utf-8") as reader, sock.makefile("w", encoding="utf-8") as writer:
            while not stop.is_set():
                line = reader.readline(MAX_BODY_BYTES + 1)
                if not line:
                    return
                response: dict[str, Any]
                request_id: Any = None
                try:
                    if len(line) > MAX_BODY_BYTES:
                        raise RuntimeError(f"{history_name} RPC request exceeds size limit")
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise RuntimeError(f"{history_name} RPC request must be an object")
                    request_id = request.get("id")
                    if not isinstance(request_id, int) or isinstance(request_id, bool) or request_id < 1:
                        raise RuntimeError(f"{history_name} RPC request has an invalid id")
                    method = request.get("method")
                    if not isinstance(method, str):
                        raise RuntimeError(f"{history_name} RPC request has an invalid method")
                    response = {
                        "id": request_id,
                        "ok": True,
                        "result": history_response(
                            method,
                            request.get("args"),
                            history,
                            client,
                            history_name=history_name,
                            allowed_methods=allowed_methods,
                        ),
                    }
                except Exception as exc:
                    response = {"id": request_id, "ok": False, "error": str(exc)[:4_000]}
                writer.write(json.dumps(response, separators=(",", ":")) + "\n")
                writer.flush()
    except (BrokenPipeError, ConnectionError, OSError):
        return


def run_child(
    program: str,
    request: dict[str, Any],
    runtime_ms: int,
    memory_mb: int,
    *,
    history: dict[str, str] | None = None,
    history_client: HistoryClient | None = None,
    history_name: str = "history",
    history_methods: HistoryMethods = frozenset(),
    label: str = "feed algorithm",
) -> tuple[int, dict[str, Any]]:
    def restrict() -> None:
        try:
            import resource
            byte_limit = memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (byte_limit, byte_limit))
            cpu_seconds = max(1, (runtime_ms + 999) // 1000)
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        except Exception:
            pass

    parent_sock: socket.socket | None = None
    child_sock: socket.socket | None = None
    process: subprocess.Popen[str] | None = None
    stop = threading.Event()
    relay: threading.Thread | None = None
    try:
        command = [sys.executable, "-I", "-c", program]
        pass_fds: tuple[int, ...] = ()
        if history is not None:
            if os.name != "posix":
                return error(f"{history_name} RPC requires a POSIX runner", HTTPStatus.NOT_IMPLEMENTED)
            parent_sock, child_sock = socket.socketpair()
            command.append(str(child_sock.fileno()))
            pass_fds = (child_sock.fileno(),)
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            pass_fds=pass_fds,
            preexec_fn=restrict if os.name == "posix" else None,
        )
        if child_sock is not None:
            child_sock.close()
            child_sock = None
        if parent_sock is not None and history is not None:
            relay = threading.Thread(
                target=serve_history_rpc,
                args=(parent_sock, history, history_client or history_http_client, stop),
                kwargs={"history_name": history_name, "allowed_methods": history_methods},
                daemon=True,
            )
            relay.start()
        child_input = json.dumps(sorted(ALLOWED_IMPORTS)) + "\n" + json.dumps(request, separators=(",", ":")) + "\n"
        stdout, stderr = process.communicate(child_input, timeout=runtime_ms / 1000)
    except subprocess.TimeoutExpired:
        if process is not None:
            process.kill()
            process.communicate()
        return error(f"{label} exceeded maxRuntimeMs", HTTPStatus.REQUEST_TIMEOUT)
    except OSError as exc:
        return error(f"{label} process failed: {exc}", HTTPStatus.UNPROCESSABLE_ENTITY)
    finally:
        stop.set()
        if parent_sock is not None:
            try:
                parent_sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if child_sock is not None:
            child_sock.close()
        if relay is not None:
            relay.join(timeout=1)
    if process is None:
        return error(f"{label} process failed", HTTPStatus.UNPROCESSABLE_ENTITY)
    if process.returncode != 0:
        detail = (stderr or stdout or f"{label} process failed").strip().splitlines()[-1]
        return error(detail, HTTPStatus.UNPROCESSABLE_ENTITY)
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError:
        return error(f"{label} returned invalid JSON", HTTPStatus.UNPROCESSABLE_ENTITY)
    if not isinstance(result, dict):
        return error(f"{label} returned an invalid response", HTTPStatus.UNPROCESSABLE_ENTITY)
    return HTTPStatus.OK, result


def execute_child(payload: dict[str, Any], *, history_client: HistoryClient | None = None) -> tuple[int, dict[str, Any]]:
    algorithm_kind = payload.get("algorithmKind", "feed")
    if algorithm_kind not in {"feed", "market_maker", "population", "network"}:
        return error("unsupported algorithm kind")
    source_error = validate_source(
        payload.get("source"),
        payload.get("dependencies"),
        subject="market makers" if algorithm_kind == "market_maker" else "world generators" if algorithm_kind in {"population", "network"} else "feed algorithms",
    )
    if source_error:
        return error(source_error)
    limits = checked_limits(payload.get("limits"))
    if isinstance(limits, str):
        return error(limits)
    runtime_ms, memory_mb = limits
    mode = payload.get("mode")
    if mode not in {"validate", "execute"}:
        return error("unsupported runner mode")
    if algorithm_kind in {"population", "network"}:
        class_name = "PopulationGenerator" if algorithm_kind == "population" else "NetworkGenerator"
        if mode == "validate":
            return run_child(
                WORLD_GENERATOR_CHILD_PROGRAM,
                {"mode": mode, "kind": algorithm_kind, "source": payload["source"]},
                runtime_ms,
                memory_mb,
                label=f"{algorithm_kind} generator",
            )
        static_context = payload.get("instruments") if algorithm_kind == "population" else payload.get("population")
        if (
            not isinstance(payload.get("config"), dict)
            or not isinstance(payload.get("seed"), str)
            or not isinstance(static_context, list)
        ):
            return error(f"{algorithm_kind} execute requires config object, seed string, and a list context")
        return run_child(
            WORLD_GENERATOR_CHILD_PROGRAM,
            {
                "mode": mode,
                "kind": algorithm_kind,
                "source": payload["source"],
                "config": payload["config"],
                "seed": payload["seed"],
                "instruments": static_context if algorithm_kind == "population" else [],
                "population": static_context if algorithm_kind == "network" else [],
            },
            runtime_ms,
            memory_mb,
            label=f"{algorithm_kind} generator",
        )
    if algorithm_kind == "market_maker" and mode == "validate":
        return run_child(
            MARKET_MAKER_CHILD_PROGRAM,
            {"mode": mode, "source": payload["source"]},
            runtime_ms,
            memory_mb,
            label="market maker",
        )
    if algorithm_kind == "feed" and mode == "validate":
        return run_child(
            CHILD_PROGRAM,
            {"mode": mode, "source": payload["source"]},
            runtime_ms,
            memory_mb,
            label="feed algorithm",
        )
    if algorithm_kind == "feed" and mode == "execute":
        actor_ids = payload.get("actorIds")
        if "snapshot" in payload:
            return error("feed execute does not accept snapshot; use socialHistory")
        if (
            not isinstance(payload.get("config"), dict)
            or not isinstance(payload.get("seed"), str)
            or not isinstance(payload.get("roundId"), int)
            or isinstance(payload.get("roundId"), bool)
            or payload.get("roundId") < 0
            or not isinstance(payload.get("feedSize"), int)
            or isinstance(payload.get("feedSize"), bool)
            or payload.get("feedSize") < 1
            or not isinstance(actor_ids, list)
            or not all(isinstance(actor_id, str) and actor_id for actor_id in actor_ids)
            or len(set(actor_ids)) != len(actor_ids)
            or actor_ids != sorted(actor_ids)
        ):
            return error("feed execute requires config object, seed string, non-negative roundId, positive feedSize, and sorted unique actorIds")
        history = checked_history_descriptor(payload.get("socialHistory"), name="socialHistory")
        if isinstance(history, str):
            return error(history)
        request = {
            "mode": mode,
            "source": payload["source"],
            "config": payload["config"],
            "seed": payload["seed"],
            "roundId": payload["roundId"],
            "feedSize": payload["feedSize"],
            "actorIds": actor_ids,
        }
        return run_child(
            CHILD_PROGRAM,
            request,
            runtime_ms,
            memory_mb,
            history=history,
            history_client=history_client,
            history_name="socialHistory",
            history_methods=frozenset({"all", "round"}),
            label="feed algorithm",
        )
    if algorithm_kind == "market_maker" and mode == "execute":
        if (
            not isinstance(payload.get("config"), dict)
            or not isinstance(payload.get("seed"), str)
            or not isinstance(payload.get("roundId"), int)
            or isinstance(payload.get("roundId"), bool)
            or payload.get("roundId") < 0
            or payload.get("timing") not in {"opening", "settlement"}
        ):
            return error("market-maker execute requires config object, seed string, non-negative roundId, and opening or settlement timing")
        history = checked_history_descriptor(payload.get("financialHistory"), name="financialHistory")
        if isinstance(history, str):
            return error(history)
        request = {
            "mode": mode,
            "source": payload["source"],
            "config": payload["config"],
            "seed": payload["seed"],
            "roundId": payload["roundId"],
            "timing": payload["timing"],
        }
        return run_child(
            MARKET_MAKER_CHILD_PROGRAM,
            request,
            runtime_ms,
            memory_mb,
            history=history,
            history_client=history_client,
            history_name="financialHistory",
            history_methods=frozenset({"all", "round", "makerAccount", "participantBaseline"}),
            label="market maker",
        )
    request = {"mode": mode, **payload}
    return run_child(CHILD_PROGRAM, request, runtime_ms, memory_mb)


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenLeekAlgorithmRunner/1"

    def do_GET(self) -> None:
        with observe_request("GET", self.path, self.headers) as observation:
            if self.path == "/health":
                observation.finish(HTTPStatus.OK)
                self.respond(HTTPStatus.OK, {"status": "ok", "python": sys.version.split()[0]})
                return
            observation.finish(HTTPStatus.NOT_FOUND)
            self.respond(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        paths = {
            "/validate": ("feed", "validate"),
            "/execute": ("feed", "execute"),
            "/market-maker/validate": ("market_maker", "validate"),
            "/market-maker/execute": ("market_maker", "execute"),
            "/world-generator/population/validate": ("population", "validate"),
            "/world-generator/population/execute": ("population", "execute"),
            "/world-generator/network/validate": ("network", "validate"),
            "/world-generator/network/execute": ("network", "execute"),
        }
        with observe_request("POST", self.path, self.headers) as observation:
            route = paths.get(self.path)
            if route is None:
                observation.finish(HTTPStatus.NOT_FOUND)
                self.respond(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                if length < 1 or length > MAX_BODY_BYTES:
                    raise ValueError("request body must be between 1 and 524288 bytes")
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                payload["algorithmKind"], payload["mode"] = route
                status, result = execute_child(payload)
            except (ValueError, json.JSONDecodeError) as exc:
                status, result = error(str(exc))
            observation.finish(status, algorithm_kind=route[0], mode=route[1])
            self.respond(status, result)

    def respond(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


if __name__ == "__main__":
    setup_observability()
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
