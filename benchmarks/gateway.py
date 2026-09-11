import asyncio
import hmac
import json
import math
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from aiohttp import web

MANIFEST = json.loads(Path(__file__).with_name("gateway.json").read_text())
UPSTREAM = "https://api.deepseek.com/chat/completions"


def price_usage(raw: dict, started_at: str) -> dict:
    def count(value):
        if type(value) is not int or value < 0:
            raise ValueError("Invalid token count")
        return value

    prompt = count(raw.get("prompt_tokens"))
    output = count(raw.get("completion_tokens"))
    total = count(raw.get("total_tokens"))
    if total != prompt + output or total == 0:
        raise ValueError("Inconsistent or empty usage")
    cached = count(raw.get("prompt_cache_hit_tokens", (raw.get("prompt_tokens_details") or {}).get("cached_tokens", 0)))
    if cached > prompt or raw.get("prompt_cache_miss_tokens", prompt - cached) != prompt - cached:
        raise ValueError("Inconsistent cache usage")
    reasoning = (raw.get("completion_tokens_details") or {}).get("reasoning_tokens")
    if reasoning is not None and count(reasoning) > output:
        raise ValueError("Reasoning exceeds output tokens")
    rates = MANIFEST["peak_usd_per_million"]
    normalized = ((prompt - cached) * rates["input"] + cached * rates["cache"] + output * rates["output"]) / 1_000_000
    at = datetime.fromisoformat(started_at).astimezone(timezone.utc)
    peak = at.weekday() < 5 and (1 <= at.hour < 4 or 6 <= at.hour < 10)
    return {
        "input": prompt - cached, "cached": cached, "output": output,
        "reasoning": reasoning, "total": total,
        "normalized_usd": normalized,
        "estimated_usd": normalized if peak else normalized / 2,
        "peak_at_dispatch": peak,
        "cache_usage_reported": "prompt_cache_hit_tokens" in raw or "cached_tokens" in (raw.get("prompt_tokens_details") or {}),
    }


class StreamAudit:
    def __init__(self):
        self.buffer = b""
        self.usage = None
        self.models = set()
        self.finish_reasons = set()
        self.done = False
        self.invalid = False

    def feed(self, chunk: bytes):
        self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                self.done = True
                continue
            try:
                event = json.loads(data)
                if event.get("usage") is not None:
                    self.usage = event["usage"]
                if isinstance(event.get("model"), str):
                    self.models.add(event["model"])
                for choice in event.get("choices", []):
                    if choice.get("finish_reason"):
                        self.finish_reasons.add(choice["finish_reason"])
            except (ValueError, TypeError, AttributeError):
                self.invalid = True
        if len(self.buffer) > 2_000_000:
            raise ValueError("Oversized SSE line")


class Gateway:
    """A single-flight, trial-scoped relay; the real key never enters task containers."""

    def __init__(self, api_key: str, budget_usd: float, ledger: Path, *, upstream=UPSTREAM,
                 reserve_usd: float = None, max_budget_usd: float = None):
        reserve = MANIFEST["request_reserve_usd"] if reserve_usd is None else reserve_usd
        ceiling = MANIFEST["max_budget_usd"] if max_budget_usd is None else max_budget_usd
        if not math.isfinite(budget_usd) or not reserve <= budget_usd <= ceiling:
            raise ValueError("Budget must cover the request reserve and not exceed the cap")
        self.api_key = api_key
        self.reserve_usd = reserve
        self.budget_usd = budget_usd
        self.ledger = ledger
        self.upstream = upstream
        self.calls = []
        self.active = None
        self.tokens = []
        self.halted = None
        self.lock = asyncio.Lock()
        self.runner = None
        self.client = None

    @property
    def spent(self):
        return sum(call.get("usage", {}).get("normalized_usd", 0) for call in self.calls)

    def activate(self, trial: str, mode: str):
        if self.active is not None or self.lock.locked() or mode not in ("max", "auto"):
            raise RuntimeError("Gateway is not ready for a new trial")
        token = secrets.token_urlsafe(32)
        self.tokens.append(token)
        self.active = (token, trial, mode)
        return token

    async def deactivate(self):
        self.active = None
        # Drain an orphaned selector stream before advancing to another trial.
        async with self.lock:
            pass

    def record(self, record):
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        with self.ledger.open("a") as file:
            file.write(json.dumps(record, ensure_ascii=True) + "\n")
            file.flush()
        if record["event"] == "end":
            self.calls.append(record)

    async def start(self, host="127.0.0.1", port=0):
        self.client = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=240), trust_env=False)
        app = web.Application(client_max_size=8_000_000)
        app.router.add_post("/chat/completions", self.handle)
        self.runner = web.AppRunner(app, access_log=None, shutdown_timeout=250)
        await self.runner.setup()
        site = web.TCPSite(self.runner, host, port)
        await site.start()
        return site._server.sockets[0].getsockname()[1]

    async def close(self):
        await self.deactivate()
        if self.runner:
            await self.runner.cleanup()
        if self.client:
            await self.client.close()

    async def handle(self, request):
        async with self.lock:
            active = self.active
            if active is None or not hmac.compare_digest(request.headers.get("Authorization", ""), f"Bearer {active[0]}"):
                return web.json_response({"error": "Invalid or expired trial token"}, status=401)
            _, trial, mode = active
            if self.halted or self.spent + self.reserve_usd > self.budget_usd:
                self.halted = self.halted or "Budget headroom exhausted"
                return web.json_response({"error": self.halted}, status=402)
            try:
                body = await request.json()
                if body.get("model") != MANIFEST["model"]["id"] or body.get("stream") is not True:
                    raise ValueError("Only streaming deepseek-flash is allowed")
                cap = body.get("max_tokens")
                if type(cap) is not int or not 1 <= cap <= MANIFEST["model"]["maxTokens"]:
                    raise ValueError("Invalid output limit")
                messages = body["messages"]
                system = messages[0].get("content", "")
                selector = not body.get("tools") and isinstance(system, str) and system.startswith("Choose the most appropriate effort in supportedEfforts")
                kind = "selector" if selector else "execution" if body.get("tools") else "auxiliary"
                thinking = body.get("thinking", {}).get("type")
                effort = "off" if thinking == "disabled" else body.get("reasoning_effort")
                if thinking not in ("enabled", "disabled") or effort not in ("off", "low", "high", "max"):
                    raise ValueError("Invalid native DeepSeek thinking payload")
                if (kind == "selector" and (mode != "auto" or effort != "low")) or (kind == "execution" and mode == "max" and effort != "max"):
                    raise ValueError("Effort does not match the experimental arm")
            except (ValueError, TypeError, KeyError, IndexError, AttributeError):
                self.halted = "Request protocol validation failed"
                return web.json_response({"error": self.halted}, status=400)
            body["stream_options"] = {"include_usage": True}
            started = time.monotonic()
            record = {
                "event": "start", "id": secrets.token_hex(8), "trial": trial,
                "mode": mode, "kind": kind, "effort": effort,
                "started_at": datetime.now(timezone.utc).isoformat(),
            }
            # A start without an end remains visible if the process/runner is killed.
            self.record(record)
            record = {**record, "event": "end"}
            audit = StreamAudit()
            downstream = None
            connected = True
            try:
                async with self.client.post(self.upstream, json=body, headers={"Authorization": f"Bearer {self.api_key}"}, allow_redirects=False) as upstream:
                    record["http_status"] = upstream.status
                    if upstream.status != 200:
                        raise RuntimeError("Upstream HTTP failure")
                    downstream = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                    try:
                        await downstream.prepare(request)
                    except ConnectionResetError:
                        connected = False
                    async for chunk in upstream.content.iter_any():
                        audit.feed(chunk)
                        if connected:
                            try:
                                await downstream.write(chunk)
                            except ConnectionResetError:
                                connected = False
            except (Exception, asyncio.CancelledError) as error:
                # Do not serialize upstream bodies, request data or credentials.
                record["error_type"] = type(error).__name__
            finally:
                record.update({"elapsed_ms": round((time.monotonic() - started) * 1000), "response_models": sorted(audit.models), "finish_reasons": sorted(audit.finish_reasons), "stream_done": audit.done, "client_disconnected": not connected})
                try:
                    record["usage"] = price_usage(audit.usage, record["started_at"])
                    record["raw_usage"] = audit.usage
                    record["complete_usage"] = not audit.invalid
                except (ValueError, TypeError, AttributeError):
                    record["complete_usage"] = False
                if not record["complete_usage"]:
                    self.halted = "Unmeasured provider request; stopping instead of treating it as free"
                self.record(record)
            if downstream is None:
                return web.json_response({"error": "Upstream request failed; see sanitized ledger"}, status=502)
            return downstream
