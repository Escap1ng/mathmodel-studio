"""题面来源：附件文字可以在题面留空时顶上，且不与上下文重复。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "modeling" / "src"))
sys.path.insert(0, str(ROOT / "gateway" / "src"))

from mms_modeling.pipeline import Pipeline  # noqa: E402
from test_ingest import make_docx  # noqa: E402


class ProblemFromDocsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.docx = self.root / "赛题.docx"
        make_docx(self.docx)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def make_pipeline(self, problem: str, paths: list[Path]) -> tuple[Pipeline, list[tuple[str, dict]]]:
        events: list[tuple[str, dict]] = []
        pipeline = Pipeline(
            job_dir=self.root / "job",
            problem=problem,
            data_paths=paths,
            provider=None,
            api_key="",
            model="offline",
            emit=lambda event, data: events.append((event, data)),
            should_stop=lambda: False,
        )
        pipeline._prepare_data()
        return pipeline, events

    def test_attachment_becomes_problem(self) -> None:
        pipeline, _ = self.make_pipeline("", [self.docx])
        pipeline._step_problem()
        self.assertTrue(pipeline.problem_from_docs)
        self.assertIn("问题一", pipeline.problem)
        self.assertGreaterEqual(len(pipeline.questions), 2)
        self.assertEqual(pipeline._doc_block(), "")

    def test_short_problem_is_combined_with_attachment(self) -> None:
        pipeline, _ = self.make_pipeline("看附件", [self.docx])
        pipeline._step_problem()
        self.assertIn("看附件", pipeline.problem)
        self.assertIn("问题一", pipeline.problem)
        self.assertTrue(pipeline.problem_from_docs)

    def test_typed_problem_is_kept_and_doc_stays_in_context(self) -> None:
        problem = "某工厂要按附件数据建立产量模型并给出工艺改进建议。"
        pipeline, _ = self.make_pipeline(problem, [self.docx])
        pipeline._step_problem()
        self.assertEqual(pipeline.problem, problem)
        self.assertFalse(pipeline.problem_from_docs)
        self.assertIn("问题一", pipeline._doc_block())

    def test_no_problem_and_no_docs_fails(self) -> None:
        pipeline, _ = self.make_pipeline("", [])
        with self.assertRaisesRegex(RuntimeError, "题面太短"):
            pipeline._step_problem()


if __name__ == "__main__":
    unittest.main()
