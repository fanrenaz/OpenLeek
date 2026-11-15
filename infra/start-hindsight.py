#!/usr/bin/env python3
"""Resolve the current shared memory route before starting Hindsight."""

import json
import os
import sys
import urllib.parse
import urllib.request


origin = os.environ["OPENLEEK_LLM_CONFIGURATION_URL"].rstrip("/")
token = os.environ["OPENLEEK_LLM_CONFIGURATION_HINDSIGHT_TOKEN"]
route = os.environ.get("OPENLEEK_HINDSIGHT_ROUTE", "memory")
request = urllib.request.Request(
    f"{origin}/internal/v1/profiles/current?consumer=hindsight&route={urllib.parse.quote(route)}",
    headers={"Accept": "application/json", "Authorization": f"Bearer {token}"},
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        profile = json.load(response)
except Exception as error:
    print(f"Hindsight shared LLM profile resolution failed: {error}", file=sys.stderr)
    raise SystemExit(1)

protocols = {
    "anthropic": "anthropic",
    "openai-chat": "openai",
    "google-genai": "gemini",
}
provider = protocols.get(profile.get("protocol"))
if not provider:
    print("Hindsight memory route uses an unsupported provider protocol", file=sys.stderr)
    raise SystemExit(1)

os.environ["HINDSIGHT_API_LLM_PROVIDER"] = provider
os.environ["HINDSIGHT_API_LLM_BASE_URL"] = profile["baseUrl"]
os.environ["HINDSIGHT_API_LLM_API_KEY"] = profile["apiKey"]
os.environ["HINDSIGHT_API_LLM_MODEL"] = profile["model"]
os.execv("/app/start-all.sh", ["/app/start-all.sh"])
