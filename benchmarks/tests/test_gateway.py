import asyncio
import json
import os
import shlex
import shutil
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, web

from benchmarks.aider import models_config, pi_command, settings_config
from benchmarks.gateway import Gateway, MANIFEST, StreamAudit, price_usage

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
USAGE = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
         "prompt_cache_hit_tokens": 60, "prompt_cache_miss_tokens": 40,
         "completion_tokens_details": {"reasoning_tokens": 12}}


def event(data):
    return b"data: " + json.dumps(data).encode() + b"\n\n"


def request_body():
    return {"model": MANIFEST["model"]["id"], "stream": True, "max_tokens": 384000,
            "messages": [{"role": "system", "content": "Test"}],
            "tools": [{"type": "function", "function": {"name": "read"}}],
            "thinking": {"type": "enabled"}, "reasoning_effort": "max"}


class AccountingTests(unittest.TestCase):
    def test_reasoning_is_a_subset_and_cache_is_not_double_counted(self):
        usage = price_usage(USAGE, "2026-09-10T07:00:00+00:00")
        self.assertEqual(usage["total"], 120)
        self.assertEqual(usage["input"], 40)
        self.assertEqual(usage["reasoning"], 12)
        self.assertAlmostEqual(usage["normalized_usd"], 0.00003636)
        self.assertEqual(usage["normalized_usd"], usage["estimated_usd"])

    def test_time_windows_are_utc_and_normalized_cost_is_constant(self):
        for date, peak in [("2026-09-10T01:00:00+00:00", True), ("2026-09-10T04:00:00+00:00", False),
                           ("2026-09-10T06:00:00+00:00", True), ("2026-09-10T10:00:00+00:00", False),
                           ("2026-09-12T07:00:00+00:00", False)]:
            with self.subTest(date=date):
                usage = price_usage(USAGE, date)
                self.assertEqual(usage["peak_at_dispatch"], peak)
                self.assertEqual(usage["estimated_usd"], usage["normalized_usd"] / (1 if peak else 2))

    def test_missing_cache_is_conservatively_priced_and_labeled(self):
        usage = price_usage({"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}, "2026-09-10T07:00:00+00:00")
        self.assertFalse(usage["cache_usage_reported"])
        self.assertIsNone(usage["reasoning"])
        self.assertGreater(usage["normalized_usd"], price_usage(USAGE, "2026-09-10T07:00:00+00:00")["normalized_usd"])

    def test_missing_and_inconsistent_usage_is_rejected(self):
        for patch in [{"total_tokens": 0}, {"prompt_tokens": -1}, {"completion_tokens": True},
                      {"prompt_cache_hit_tokens": 101}, {"prompt_cache_miss_tokens": 0},
                      {"completion_tokens_details": {"reasoning_tokens": 21}}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                price_usage({**USAGE, **patch}, "2026-09-10T07:00:00+00:00")

    def test_stream_parser_handles_arbitrary_chunks(self):
        data = event({"model": "deepseek-flash", "usage": USAGE, "choices": [{"finish_reason": "stop"}]}) + b"data: [DONE]\r\n\r\n"
        audit = StreamAudit()
        for byte in data:
            audit.feed(bytes([byte]))
        self.assertEqual(audit.usage, USAGE)
        self.assertTrue(audit.done)
        self.assertFalse(audit.invalid)
        self.assertEqual(audit.models, {"deepseek-flash"})
        audit.feed(b"data: invalid\n\n")
        self.assertTrue(audit.invalid)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.requests = []
        self.omit_usage = False
        self.fail_http = False
        self.slow = False
        self.release = asyncio.Event()
        self.received = asyncio.Event()
        self.selected_effort = "high"
        app = web.Application()
        app.router.add_post("/chat/completions", self.upstream)
        self.upstream_runner = web.AppRunner(app, access_log=None)
        await self.upstream_runner.setup()
        site = web.TCPSite(self.upstream_runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.gateway = Gateway("fake-real-key", 5, self.directory / "calls.jsonl", upstream=f"http://127.0.0.1:{port}/chat/completions")
        port = await self.gateway.start()
        self.endpoint = f"http://127.0.0.1:{port}"
        self.client = ClientSession()

    async def asyncTearDown(self):
        self.release.set()
        await self.gateway.close()
        await self.client.close()
        await self.upstream_runner.cleanup()
        self.temp.cleanup()

    async def upstream(self, request):
        self.assertEqual(request.headers["Authorization"], "Bearer fake-real-key")
        body = await request.json()
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.requests.append(body)
        if self.fail_http:
            return web.Response(status=503, text="private upstream diagnostics")
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        self.received.set()
        await response.write(b": keepalive\n\n")
        if self.slow:
            await self.release.wait()
        choice = {"index": 0, "delta": {}, "finish_reason": "stop"}
        if not body.get("tools"):
            choice["delta"] = {"content": json.dumps({"effort": self.selected_effort, "reason": "Integration test decision"})}
        elif any(message.get("role") == "tool" for message in body["messages"]):
            choice["delta"] = {"content": "Done."}
        else:
            choice["finish_reason"] = "tool_calls"
            choice["delta"] = {"reasoning_content": "Inspect the fixture.", "tool_calls": [{"index": 0, "id": "read_fixture", "type": "function", "function": {"name": "read", "arguments": '{"path":"fixture.txt"}'}}]}
        await response.write(event({"id": "mock-response", "model": MANIFEST["model"]["id"], "choices": [choice]}))
        if not self.omit_usage:
            await response.write(event({"choices": [], "usage": USAGE}))
        await response.write(b"data: [DONE]\n\n")
        return response

    async def send(self, token, body=None):
        async with self.client.post(self.endpoint + "/chat/completions", json=body or request_body(), headers={"Authorization": f"Bearer {token}"}) as response:
            await response.read()
            return response.status

    async def test_auth_model_and_effort_validation_prevent_unmetered_bypass(self):
        token = self.gateway.activate("max-1", "max")
        self.assertEqual(await self.send("wrong"), 401)
        bad = {**request_body(), "reasoning_effort": "high"}
        self.assertEqual(await self.send(token, bad), 400)
        self.assertEqual(self.requests, [])
        self.assertIsNotNone(self.gateway.halted)

    async def test_other_models_nonstreaming_and_oversized_output_are_rejected(self):
        token = self.gateway.activate("max-1", "max")
        for patch in [{"model": "deepseek-pro"}, {"stream": False}, {"max_tokens": 384001}]:
            with self.subTest(patch=patch):
                self.gateway.halted = None
                self.assertEqual(await self.send(token, {**request_body(), **patch}), 400)
        self.assertEqual(self.requests, [])

    async def test_missing_usage_stops_future_paid_requests(self):
        self.omit_usage = True
        token = self.gateway.activate("max-1", "max")
        self.assertEqual(await self.send(token), 200)
        self.assertFalse(self.gateway.calls[0]["complete_usage"])
        self.assertEqual(await self.send(token), 402)
        self.assertEqual(len(self.requests), 1)

    async def test_http_failure_is_not_free_and_diagnostics_are_not_forwarded(self):
        self.fail_http = True
        token = self.gateway.activate("max-1", "max")
        self.assertEqual(await self.send(token), 502)
        self.assertFalse(self.gateway.calls[0]["complete_usage"])
        self.assertNotIn("private upstream", self.gateway.ledger.read_text())

    async def test_reserve_is_checked_before_upstream_dispatch(self):
        self.gateway.budget_usd = 0.8
        self.gateway.reserve_usd = 0.8
        token = self.gateway.activate("max-1", "max")
        self.assertEqual(await self.send(token), 200)
        self.assertEqual(await self.send(token), 402)
        self.assertEqual(len(self.requests), 1)
        await self.gateway.deactivate()
        self.assertEqual(await self.send(token), 401)

    async def test_disconnected_selector_is_drained_and_next_request_is_serialized(self):
        self.slow = True
        token = self.gateway.activate("auto-1", "auto")
        body = request_body()
        body.pop("tools")
        body["messages"][0]["content"] = "Choose the most appropriate effort in supportedEfforts"
        body["reasoning_effort"] = "low"
        response = await self.client.post(self.endpoint + "/chat/completions", json=body, headers={"Authorization": f"Bearer {token}"})
        await self.received.wait()
        response.close()
        second = asyncio.create_task(self.send(token))
        await asyncio.sleep(0.03)
        self.assertEqual(len(self.requests), 1)
        self.release.set()
        self.assertEqual(await second, 200)
        self.assertEqual(len(self.gateway.calls), 2)
        self.assertTrue(all(call["complete_usage"] for call in self.gateway.calls))
        self.assertEqual(self.gateway.calls[0]["kind"], "selector")

    async def run_pi(self, arm, trial):
        fixture = self.directory / trial
        config = fixture / "config"
        config.mkdir(parents=True)
        shutil.copytree(REPO / "src", fixture / "extension")
        (fixture / "fixture.txt").write_text("Integration fixture\n")
        (config / "models.json").write_text(json.dumps(models_config(self.endpoint)))
        (config / "settings.json").write_text(json.dumps(settings_config()))
        token = self.gateway.activate(trial, arm)
        command = pi_command("Read fixture.txt and report completion.", arm, str(fixture / "sessions"))
        command[0] = str(REPO / "node_modules/.bin/pi")
        command = [str(fixture / "extension/index.ts") if arg == str(REPO / "src" / "index.ts") else arg for arg in command]
        process = await asyncio.create_subprocess_exec(*command, cwd=fixture,
            env={"PATH": os.environ["PATH"], "HOME": str(fixture), "PI_CODING_AGENT_DIR": str(config),
                 "BENCH_GATEWAY_TOKEN": token, "TERM": "dumb"},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
        except BaseException:
            process.kill()
            await process.wait()
            raise
        await self.gateway.deactivate()
        self.assertEqual(process.returncode, 0, (stdout + stderr).decode()[-8000:])
        self.assertNotIn("fake-real-key", (stdout + stderr).decode())
        return fixture, [c for c in self.gateway.calls if c["trial"] == trial]

    async def test_real_pi_cli_extension_and_deepseek_wire_payload(self):
        _, fixed = await self.run_pi("max", "max-1")
        self.assertEqual([call["effort"] for call in fixed], ["max", "max"])
        for effort in ["high", "off"]:
            self.selected_effort = effort
            fixture, auto = await self.run_pi("auto", f"auto-{effort}")
            self.assertEqual([call["kind"] for call in auto], ["selector", "execution", "execution"])
            self.assertEqual([call["effort"] for call in auto], ["low", effort, effort])
            self.assertEqual(sum(call["usage"]["total"] for call in auto), 360)
            session = next((fixture / "sessions").glob("*.jsonl")).read_text()
            self.assertIn('"customType":"pi-auto-decision"', session)
        replay = [m for body in self.requests for m in body["messages"] if m.get("role") == "assistant" and m.get("tool_calls")]
        self.assertTrue(replay)
        self.assertTrue(all("reasoning_content" in message for message in replay))


if __name__ == "__main__":
    unittest.main()
