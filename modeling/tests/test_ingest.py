"""附件入口的回归测试：用手工拼的最小 xlsx/docx/zip 夹具跑 prepare。"""

from __future__ import annotations

import csv
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mms_modeling import ingest  # noqa: E402

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def make_xlsx(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet1 = f"""<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="{MAIN}"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2"><v>1.5</v></c><c r="C2"><v>3</v></c></row>
<row r="3"><c r="A3" s="1"><v>45293</v></c><c r="B3" t="inlineStr"><is><t>2.5</t></is></c><c r="C3"><f>B3*2</f><v>5</v></c></row>
</sheetData></worksheet>"""
    sheet2 = f"""<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="{MAIN}"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>备注</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>示例</t></is></c></row>
</sheetData></worksheet>"""
    workbook = f"""<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="{MAIN}" xmlns:r="{REL}">
<workbookPr/>
<sheets>
<sheet name="数据" sheetId="1" r:id="rId1"/>
<sheet name="说明" sheetId="2" r:id="rId2"/>
</sheets></workbook>"""
    rels = f"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="{PKG}">
<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>"""
    shared = f"""<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="{MAIN}" count="3" uniqueCount="3">
<si><t>日期</t></si><si><t>温度</t></si><si><t>产量</t></si>
</sst>"""
    styles = f"""<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="{MAIN}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs>
</styleSheet>"""
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", rels)
        zf.writestr("xl/sharedStrings.xml", shared)
        zf.writestr("xl/styles.xml", styles)
        zf.writestr("xl/worksheets/sheet1.xml", sheet1)
        zf.writestr("xl/worksheets/sheet2.xml", sheet2)


def make_docx(path: Path, text: str = "问题一：预测产量", dtd: bool = False) -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="{W}"><w:body>
<w:p><w:r><w:t>{text}</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>年份</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>产量</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>问题二：稳健性分析</w:t></w:r></w:p>
</w:body></w:document>"""
    if dtd:
        body = body.replace("<w:document", '<!DOCTYPE w:document [<!ENTITY x "y">]><w:document')
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("word/document.xml", body)


def read_csv(path: Path) -> list[list[str]]:
    return list(csv.reader(io.StringIO(Path(path).read_text(encoding="utf-8-sig"))))


class IngestTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.work = self.root / "work"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_xlsx_sheets_become_csv(self) -> None:
        src = self.root / "附件1.xlsx"
        make_xlsx(src)
        info = ingest.prepare([src], self.work)
        self.assertEqual(info["errors"], [])
        self.assertEqual(len(info["tables"]), 2)
        first = info["tables"][0]
        self.assertEqual((first["name"], first["sheet"], first["rows"], first["cols"]), ("附件1.xlsx", "数据", 2, 3))
        self.assertEqual(
            read_csv(Path(first["path"])),
            [["日期", "温度", "产量"], ["2024-01-01", "1.5", "3"], ["2024-01-02", "2.5", "5"]],
        )
        second = info["tables"][1]
        self.assertEqual((second["sheet"], second["rows"]), ("说明", 1))

    def test_docx_text_in_order(self) -> None:
        src = self.root / "要求.docx"
        make_docx(src)
        info = ingest.prepare([src], self.work)
        self.assertEqual(info["tables"], [])
        self.assertEqual(len(info["docs"]), 1)
        text = info["docs"][0]["text"]
        self.assertLess(text.index("问题一"), text.index("年份"))
        self.assertLess(text.index("年份"), text.index("问题二"))
        self.assertIn("问题二：稳健性分析", text)

    def test_zip_expands_tables_and_docs(self) -> None:
        xlsx = self.root / "data.xlsx"
        docx = self.root / "说明.docx"
        make_xlsx(xlsx)
        make_docx(docx)
        bundle = self.root / "赛题附件.zip"
        with zipfile.ZipFile(bundle, "w") as zf:
            zf.write(xlsx, "data.xlsx")
            zf.write(docx, "doc/说明.docx")
            zf.writestr("__MACOSX/._data.xlsx", b"junk")
            zf.writestr("ignore.txt", b"junk")
        info = ingest.prepare([bundle], self.work)
        self.assertEqual(info["errors"], [])
        self.assertEqual([t["sheet"] for t in info["tables"]], ["数据", "说明"])
        self.assertTrue(all(t["name"].startswith("赛题附件.zip/") for t in info["tables"]))
        self.assertEqual([d["name"] for d in info["docs"]], ["赛题附件.zip/doc/说明.docx"])

    def test_zip_slip_rejected(self) -> None:
        bundle = self.root / "evil.zip"
        with zipfile.ZipFile(bundle, "w") as zf:
            zf.writestr("../escape.csv", "a,b\n1,2\n")
        info = ingest.prepare([bundle], self.work)
        self.assertTrue(any("越界路径" in item for item in info["errors"]))
        self.assertFalse((self.root / "escape.csv").exists())

    def test_unsupported_suffix_reports_error(self) -> None:
        old = self.root / "旧表.xls"
        old.write_bytes(b"\xd0\xcf\x11\xe0")
        info = ingest.prepare([old], self.work)
        self.assertEqual(info["tables"], [])
        self.assertTrue(any("不支持的附件格式" in item for item in info["errors"]))

    def test_same_xlsx_name_in_two_dirs(self) -> None:
        first = self.root / "a" / "数据.xlsx"
        second = self.root / "b" / "数据.xlsx"
        make_xlsx(first)
        make_xlsx(second)
        info = ingest.prepare([first, second], self.work)
        paths = [item["path"] for item in info["tables"]]
        self.assertEqual(len(paths), 4)
        self.assertEqual(len(set(paths)), 4)

    def test_dtd_rejected(self) -> None:
        src = self.root / "带实体.docx"
        make_docx(src, dtd=True)
        info = ingest.prepare([src], self.work)
        self.assertEqual(info["docs"], [])
        self.assertTrue(any("DTD" in item for item in info["errors"]))


if __name__ == "__main__":
    unittest.main()
