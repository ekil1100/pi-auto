"""Local Aider polyglot pilot: fixed `max` versus pi-auto `auto`.

Runs the pinned polyglot-benchmark exercises on this machine (no Docker, no
Harbor) and grades them with each track's own test suite. All provider traffic
goes through `benchmarks.gateway` so selector and execution calls are metered
the same way as the Terminal-Bench pilot.

Commands:
    plan    Print the task matrix. Makes no network or model requests.
    fetch   Clone the pinned exercise checkout into benchmarks/.cache.
    oracle  Grade the bundled reference solutions. No model requests.
    compare Run max/auto through Pi and the metering gateway (paid).
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from benchmarks.gateway import Gateway, MANIFEST as GATEWAY

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
MANIFEST = json.loads((BENCH / "aider.json").read_text())
CHECKOUT = BENCH / ".cache" / "polyglot-benchmark"
SOLUTION_DIRS = (".meta", ".approaches")
STALE_DIRS = ("build", "target", "node_modules")


class AiderBenchmarkError(RuntimeError):
    """A diagnostic that is safe to print without exposing agent output."""


def selected(languages=None, slugs=None):
    tasks = MANIFEST["tasks"]
    if languages:
        tasks = [task for task in tasks if task["language"] in languages]
    if slugs:
        tasks = [task for task in tasks if task["slug"] in slugs]
    return tasks


def plan(languages, budget):
    tasks = selected(languages)
    if not tasks:
        raise AiderBenchmarkError("No tasks selected")
    reserve = GATEWAY["request_reserve_usd"]
    if not math.isfinite(budget) or not len(tasks) * reserve <= budget <= GATEWAY["max_budget_usd"]:
        raise AiderBenchmarkError("Budget must cover the per-task reserve and stay within the cap")
    return {"include": [{"language": task["language"], "slug": task["slug"], "budget_usd": budget / len(tasks)}
                        for task in tasks]}


def exercise_dir(task, root=CHECKOUT):
    return root / task["language"] / "exercises" / "practice" / task["slug"]


def reference_files(task, root=CHECKOUT):
    """Reference solution paths relative to the exercise directory."""
    lang, slug = task["language"], task["slug"]
    underscored = slug.replace("-", "_")
    if lang == "python":
        return [(".meta/example.py", f"{underscored}.py")]
    if lang == "javascript":
        return [(".meta/proof.ci.js", f"{slug}.js")]
    if lang == "go":
        return [(".meta/example.go", f"{underscored}.go")]
    if lang == "rust":
        return [(".meta/example.rs", "src/lib.rs")]
    if lang == "cpp":
        return [(".meta/example.cpp", f"{underscored}.cpp"), (".meta/example.h", f"{underscored}.h")]
    if lang == "java":
        reference = exercise_dir(task, root) / ".meta" / "src" / "reference" / "java"
        return [(f".meta/src/reference/java/{name}", f"src/main/java/{name}")
                for name in sorted(os.listdir(reference))]
    raise AiderBenchmarkError(f"Unknown track: {lang}")


def grading_commands(task):
    lang, slug = task["language"], task["slug"]
    underscored = slug.replace("-", "_")
    table = {
        "python": [["python3", "-m", "unittest", f"{underscored}_test"]],
        "javascript": [["npm", "test", "--silent"]],
        "go": [["go", "test", "./..."]],
        "rust": [["cargo", "test", "--quiet"]],
        "java": [["./gradlew", "test", "--console=plain", "--no-daemon"]],
        "cpp": [["cmake", "-S", ".", "-B", "build"], ["cmake", "--build", "build"]],
    }
    if lang not in table:
        raise AiderBenchmarkError(f"Unknown track: {lang}")
    return table[lang]


def setup_commands(task):
    """Track-specific dependency preparation, run before the agent and the grader."""
    lang = task["language"]
    table = {
        "python": [],
        "javascript": [["npm", "install", "--no-audit", "--no-fund", "--silent"]],
        "go": [["go", "mod", "download"]],
        "rust": [["cargo", "fetch", "--quiet"]],
        "java": [["./gradlew", "--no-daemon", "--console=plain", "testClasses"]],
        "cpp": [],
    }
    if lang not in table:
        raise AiderBenchmarkError(f"Unknown track: {lang}")
    return table[lang]


def prepare_dependencies(task, workdir, timeout):
    commands = setup_commands(task)
    return (True, "") if not commands else run_commands(commands, workdir, timeout)


def prepare_workdir(task, destination, *, oracle=False, root=CHECKOUT):
    """Copy an exercise, strip the solution, and optionally inject the reference."""
    source = exercise_dir(task, root)
    if not source.is_dir():
        raise AiderBenchmarkError(f"Exercise is not fetched: {task['language']}/{task['slug']}")
    shutil.copytree(source, destination)
    if oracle:
        for relative, target in reference_files(task, root):
            resolved = (destination / target).resolve()
            if destination.resolve() not in resolved.parents:
                raise AiderBenchmarkError("Reference target escapes the exercise directory")
            resolved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(exercise_dir(task, root) / relative, resolved)
    for name in (*SOLUTION_DIRS, *STALE_DIRS):
        shutil.rmtree(destination / name, ignore_errors=True)
    return destination


def instruction(task, root=CHECKOUT):
    docs = exercise_dir(task, root) / ".docs"
    parts = [path.read_text() for path in
             (docs / "instructions.md", docs / "instructions.append.md", docs / "hints.md") if path.exists()]
    return ("Implement the exercise in the current working directory so its test suite passes. "
            "Read the task files and tests, then change only implementation files. Do not edit tests.\n\n"
            + "\n\n".join(parts))


def run_commands(commands, workdir, timeout):
    output = []
    for command in commands:
        try:
            result = subprocess.run(command, cwd=workdir, capture_output=True, text=True, timeout=timeout)
        except (subprocess.SubprocessError, OSError) as error:
            return False, f"{' '.join(command)}: {type(error).__name__}"
        output.append(f"$ {' '.join(command)}\n{result.stdout}{result.stderr}".strip())
        if result.returncode != 0:
            return False, "\n\n".join(output)
    return True, "\n\n".join(output)


def grade(task, workdir, timeout):
    return run_commands(grading_commands(task), workdir, timeout)


def fetch(force=False):
    if CHECKOUT.exists() and not force:
        revision = subprocess.check_output(["git", "-C", str(CHECKOUT), "rev-parse", "HEAD"], text=True).strip()
        if revision != MANIFEST["revision"]:
            raise AiderBenchmarkError("Cached checkout is at a different revision; rerun with --force")
        return CHECKOUT
    shutil.rmtree(CHECKOUT, ignore_errors=True)
    CHECKOUT.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "clone", "--quiet", "--depth", "1", MANIFEST["repository"], str(CHECKOUT)], check=True)
    revision = subprocess.check_output(["git", "-C", str(CHECKOUT), "rev-parse", "HEAD"], text=True).strip()
    if revision != MANIFEST["revision"]:
        raise AiderBenchmarkError("Fetched revision does not match the manifest")
    return CHECKOUT


def run_oracle(args):
    fetch()
    rows = []
    for task in selected(args.languages):
        with tempfile.TemporaryDirectory() as directory:
            workdir = prepare_workdir(task, Path(directory) / "exercise", oracle=True)
            ready, log = prepare_dependencies(task, workdir, args.timeout)
            if not ready:
                raise AiderBenchmarkError(f"Environment not ready for {task['language']}/{task['slug']}\n{log[-2000:]}")
            passed, log = grade(task, workdir, args.timeout)
        rows.append({"language": task["language"], "slug": task["slug"], "passed": passed})
        print(f"{task['language']}/{task['slug']}: {'pass' if passed else 'FAIL'}")
        if not passed and args.verbose:
            print(log[-2000:])
    failed = [row for row in rows if not row["passed"]]
    if failed:
        raise AiderBenchmarkError(f"Reference solutions failed: {len(failed)}/{len(rows)}")
    print(f"Oracle passed for {len(rows)} exercises; no model requests were made")


def pi_binary():
    found = shutil.which("pi")
    if found:
        return found
    local = ROOT / "node_modules" / ".bin" / "pi"
    if local.exists():
        return str(local)
    raise AiderBenchmarkError("The pi CLI is not on PATH and node_modules/.bin/pi is missing")


def models_config(endpoint):
    return {"providers": {"deepseek": {"baseUrl": endpoint, "apiKey": "$BENCH_GATEWAY_TOKEN",
                                       "api": "openai-completions", "models": [GATEWAY["model"]]}}}


def settings_config():
    return {"compaction": {"enabled": False},
            "retry": {"enabled": False, "maxRetries": 0, "provider": {"maxRetries": 0}},
            "quietStartup": True}


def pi_command(prompt, arm, session_dir):
    if arm not in MANIFEST["arms"]:
        raise AiderBenchmarkError(f"Unknown arm: {arm}")
    args = ["pi", "--print", "--mode", "json", "--provider", "deepseek",
            "--model", GATEWAY["model"]["id"], "--thinking", "max",
            "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
            "--session-dir", str(session_dir)]
    if arm == "auto":
        args += ["--extension", str(ROOT / "src" / "index.ts")]
    return args + [prompt]


def provenance():
    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(ROOT), *arguments], text=True).strip()
    return {"dataset": MANIFEST["dataset"], "revision": MANIFEST["revision"], "manifest": MANIFEST,
            "gateway_manifest": GATEWAY,
            "extension_commit": git("rev-parse", "HEAD"), "dirty_checkout": bool(git("status", "--porcelain")),
            "source_sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in sorted((ROOT / "src").glob("*.ts"))},
            "started_at": datetime.now(timezone.utc).isoformat()}


def execute(task, arm, config_dir, session_dir, token, timeout):
    environment = {"PATH": os.environ["PATH"], "HOME": str(config_dir.parent),
                   "PI_CODING_AGENT_DIR": str(config_dir), "BENCH_GATEWAY_TOKEN": token,
                   "TERM": "dumb"}
    command = [pi_binary(), *pi_command(instruction(task), arm, session_dir)[1:]]
    result = subprocess.run(command, cwd=config_dir.parent / "exercise", capture_output=True, text=True,
                            timeout=timeout, env=environment)
    return result.returncode == 0, (result.stdout + result.stderr)[-4000:]


async def run_compare(args):
    tasks = selected(args.languages, args.slugs)
    if not tasks:
        raise AiderBenchmarkError("No tasks selected")
    fetch()
    key = os.environ.pop("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise AiderBenchmarkError("DEEPSEEK_API_KEY is required; subscription auth is not used")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
    output = (args.output or BENCH / "results" / f"aider-{stamp}").resolve()
    output.mkdir(parents=True, exist_ok=True)
    gateway = Gateway(key, args.budget_usd, output / "calls.jsonl",
                      reserve_usd=GATEWAY["request_reserve_usd"], max_budget_usd=GATEWAY["max_budget_usd"])
    port = await gateway.start()
    endpoint = f"http://127.0.0.1:{port}"
    summary = {"provenance": provenance(), "budget_usd": args.budget_usd, "rows": []}
    try:
        for index, task in enumerate(tasks):
            arms = ["max", "auto"] if index % 2 == 0 else ["auto", "max"]
            for arm in arms:
                if gateway.halted:
                    raise AiderBenchmarkError(gateway.halted)
                trial = f"{task['language']}/{task['slug']}#{arm}"
                token = gateway.activate(trial, arm)
                row = {"task": task, "arm": arm, "status": "started", "passed": False}
                started = time.monotonic()
                try:
                    with tempfile.TemporaryDirectory() as directory:
                        home = Path(directory)
                        workdir = prepare_workdir(task, home / "exercise")
                        ready, setup_log = prepare_dependencies(task, workdir, args.timeout)
                        row["setup_ok"] = ready
                        if not ready:
                            row["error"] = "environment_not_ready"
                            row["grade_log"] = setup_log[-2000:]
                            continue
                        config_dir = home / "config"
                        config_dir.mkdir()
                        (config_dir / "models.json").write_text(json.dumps(models_config(endpoint)))
                        (config_dir / "settings.json").write_text(json.dumps(settings_config()))
                        row["agent_ok"], row["agent_log"] = execute(task, arm, config_dir, home / "sessions", token, args.timeout)
                        row["passed"], row["grade_log"] = grade(task, workdir, args.timeout)
                except (subprocess.SubprocessError, OSError) as error:
                    row["error"] = type(error).__name__
                finally:
                    await gateway.deactivate()
                    row["elapsed_seconds"] = round(time.monotonic() - started, 3)
                    row["calls"] = [call for call in gateway.calls if call["trial"] == trial]
                    row["status"] = "finished" if row.get("agent_ok") else "failed"
                    summary["rows"].append(row)
                    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
                print(f"{trial}: passed={row['passed']} calls={len(row['calls'])}")
    finally:
        await gateway.close()
    report = aggregate(summary["rows"])
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["groups"], indent=2))


def aggregate(rows):
    groups = {arm: {"planned": 0, "graded": 0, "passed": 0, "tokens": 0, "seconds": 0.0,
                    "unmeasured_calls": 0, "regressions": []} for arm in MANIFEST["arms"]}
    outcomes = {}
    for row in rows:
        group = groups[row["arm"]]
        group["planned"] += 1
        group["graded"] += row.get("agent_ok", False)
        group["passed"] += bool(row["passed"])
        group["seconds"] += row.get("elapsed_seconds", 0.0)
        for call in row["calls"]:
            usage = call.get("usage", {})
            group["tokens"] += usage.get("total", 0)
            if call.get("event") == "end" and not call.get("complete_usage"):
                group["unmeasured_calls"] += 1
        outcomes[(row["task"]["language"], row["task"]["slug"], row["arm"])] = bool(row["passed"])
    for (language, slug, arm) in list(outcomes):
        if arm == "auto" and outcomes.get((language, slug, "max")) and not outcomes[(language, slug, "auto")]:
            groups["auto"]["regressions"].append(f"{language}/{slug}")
    return {"groups": groups}


def main():
    parser = argparse.ArgumentParser(description="Aider polyglot pilot (plan/fetch/oracle make no model requests)")
    parser.add_argument("command", nargs="?", choices=["plan", "fetch", "oracle", "compare"], default="plan")
    parser.add_argument("--languages", nargs="*", choices=sorted({task["language"] for task in MANIFEST["tasks"]}))
    parser.add_argument("--slugs", nargs="*")
    parser.add_argument("--budget-usd", type=float, default=MANIFEST["default_budget_usd"])
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-paid", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "plan":
            print(json.dumps(plan(args.languages, args.budget_usd)))
        elif args.command == "fetch":
            print(fetch(force=args.force))
        elif args.command == "oracle":
            run_oracle(args)
        else:
            if not args.allow_paid:
                raise AiderBenchmarkError("Paid execution requires --allow-paid")
            asyncio.run(run_compare(args))
    except AiderBenchmarkError as error:
        print(f"Benchmark stopped: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
