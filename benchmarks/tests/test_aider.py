import tempfile
import unittest
from pathlib import Path

from benchmarks.aider import (AiderBenchmarkError, MANIFEST, grading_commands, instruction, plan,
                              prepare_workdir, selected, setup_commands)
from benchmarks.gateway import Gateway

EXPECTED_COUNTS = {"python": 8, "javascript": 7, "go": 7, "java": 6, "rust": 6, "cpp": 6}


def make_exercise(root, language, slug):
    base = root / language / "exercises" / "practice" / slug
    (base / ".meta").mkdir(parents=True)
    (base / ".docs").mkdir()
    (base / ".meta" / "example.py").write_text("REFERENCE\n")
    (base / "demo.py").write_text("stub\n")
    (base / ".docs" / "instructions.md").write_text("Do the thing.\n")
    return base


class ManifestTests(unittest.TestCase):
    def test_selection_is_stratified_unique_and_complete(self):
        tasks = MANIFEST["tasks"]
        self.assertEqual(len(tasks), sum(EXPECTED_COUNTS.values()))
        counts = {}
        for task in tasks:
            counts[task["language"]] = counts.get(task["language"], 0) + 1
        self.assertEqual(counts, EXPECTED_COUNTS)
        self.assertEqual(len({(task["language"], task["slug"]) for task in tasks}), len(tasks))

    def test_filters_and_plan_split_the_budget(self):
        self.assertEqual(len(selected(["python"])), 8)
        self.assertEqual(len(selected(None, ["bowling"])), 1)
        matrix = plan(None, 10)["include"]
        self.assertEqual(len(matrix), 40)
        self.assertAlmostEqual(sum(row["budget_usd"] for row in matrix), 10)

    def test_plan_rejects_budgets_below_the_reserve_or_above_the_cap(self):
        for budget in [0.5, 11, float("nan"), float("inf")]:
            with self.subTest(budget=budget), self.assertRaises(AiderBenchmarkError):
                plan(None, budget)


class GradingTests(unittest.TestCase):
    def test_every_track_maps_to_a_runnable_command_list(self):
        for language in EXPECTED_COUNTS:
            with self.subTest(language=language):
                commands = grading_commands({"language": language, "slug": "demo-thing"})
                self.assertTrue(commands)
                for command in commands:
                    self.assertIsInstance(command, list)
                    self.assertTrue(all(isinstance(part, str) for part in command))

    def test_unknown_track_is_rejected(self):
        with self.assertRaises(AiderBenchmarkError):
            grading_commands({"language": "cobol", "slug": "hello"})

    def test_setup_is_track_specific_and_optional(self):
        self.assertEqual(setup_commands({"language": "python", "slug": "demo"}), [])
        self.assertTrue(setup_commands({"language": "javascript", "slug": "demo"}))
        with self.assertRaises(AiderBenchmarkError):
            setup_commands({"language": "cobol", "slug": "hello"})


class WorkdirTests(unittest.TestCase):
    def test_oracle_injects_the_reference_and_strips_the_solution_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            make_exercise(root, "python", "demo")
            workdir = prepare_workdir({"language": "python", "slug": "demo"}, Path(directory) / "work",
                                      oracle=True, root=root)
            self.assertEqual((workdir / "demo.py").read_text(), "REFERENCE\n")
            self.assertFalse((workdir / ".meta").exists())

    def test_agent_workdir_keeps_the_stub_and_hides_the_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            make_exercise(root, "python", "demo")
            workdir = prepare_workdir({"language": "python", "slug": "demo"}, Path(directory) / "work", root=root)
            self.assertEqual((workdir / "demo.py").read_text(), "stub\n")
            self.assertFalse((workdir / ".meta").exists())
            self.assertIn("Do the thing.", instruction({"language": "python", "slug": "demo"}, root=root))

    def test_missing_exercise_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(AiderBenchmarkError):
                prepare_workdir({"language": "python", "slug": "absent"}, Path(directory) / "work",
                                root=Path(directory) / "root")


class GatewayReserveTests(unittest.TestCase):
    def test_reserve_is_configurable_for_small_task_sets(self):
        gateway = Gateway("key", 0.5, Path("/tmp/aider-reserve-test.jsonl"), reserve_usd=0.05, max_budget_usd=10)
        self.assertEqual(gateway.reserve_usd, 0.05)
        self.assertEqual(gateway.budget_usd, 0.5)


if __name__ == "__main__":
    unittest.main()
