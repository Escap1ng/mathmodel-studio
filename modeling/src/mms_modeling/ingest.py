"""附件入口：把竞赛附件统一成可跑的 CSV 与可读的文字。

支持 CSV / TSV / XLSX / DOCX，以及包含它们的 ZIP（只展开一层）。解析只用标准库：
xlsx 与 docx 都是 zip + XML，读它们不需要 openpyxl，随包 Python 无需新增依赖。

约定：xlsx 的每个非空工作表各写成一份 UTF-8-SIG CSV；日期单元格按样式号转成
ISO 文本；docx 只抽正文文字，供题面拆解与论文撰写当上下文。
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import re
import shutil
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

SUFFIXES = (".csv", ".tsv", ".xlsx", ".docx", ".zip")
MAX_UNZIP_BYTES = 200 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024
MAX_SHEET_ROWS = 200_000
MAX_DOC_CHARS = 4000

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_DATE_FORMAT_IDS = frozenset({14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57})


def prepare(paths: list[Path], work_dir: Path) -> dict:
    """把附件展开、转换为统一格式。

    返回 {"tables": [...], "docs": [...], "errors": [...]}：
    tables 每项含 name / sheet / path / rows / cols，path 指向可直接喂给
    求解脚本的 CSV；docs 每项含 name / chars / text（已截断）。
    """
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    items: list[tuple[str, Path]] = []
    errors: list[str] = []

    for raw in paths:
        path = Path(raw)
        suffix = path.suffix.lower()
        if suffix not in SUFFIXES:
            errors.append(
                f"不支持的附件格式：{path.name}（支持 " + " / ".join(s.lstrip(".").upper() for s in SUFFIXES) + "）"
            )
            continue
        if suffix == ".zip":
            base = work_dir / "zip" / _slug(path.stem)
            for child in _expand_zip(path, base, errors):
                rel = child.relative_to(base).as_posix()
                items.append((f"{path.name}/{rel}", child))
        else:
            items.append((path.name, path))

    tables: list[dict] = []
    docs: list[dict] = []
    used_names: set[str] = set()
    for label, path in items:
        suffix = path.suffix.lower()
        try:
            if suffix in (".csv", ".tsv"):
                tables.append(_csv_table(path, label))
            elif suffix == ".xlsx":
                tables.extend(_xlsx_tables(path, label, work_dir / "tables", used_names, errors))
            elif suffix == ".docx":
                text = _docx_text(path).strip()
                if text:
                    docs.append({"name": label, "chars": len(text), "text": text[:MAX_DOC_CHARS]})
                else:
                    errors.append(f"{label} 里没有可读文字")
        except (OSError, KeyError, ValueError, zipfile.BadZipFile, ET.ParseError) as exc:
            errors.append(f"{label} 解析失败：{exc}")
    return {"tables": tables, "docs": docs, "errors": errors}


# ---------- CSV / TSV ----------


def _decode(raw: bytes) -> str | None:
    for encoding in ("utf-8-sig", "gbk", "utf-8"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return None


def _csv_table(path: Path, label: str) -> dict:
    text = _decode(path.read_bytes())
    if text is None:
        raise ValueError("文件无法解码（试过 utf-8-sig / gbk / utf-8）")
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter) if any(cell.strip() for cell in row)]
    width = max((len(row) for row in rows), default=0)
    return {
        "name": label,
        "sheet": "",
        "path": str(path),
        "rows": max(0, len(rows) - 1),
        "cols": width,
    }


# ---------- ZIP ----------


def _expand_zip(path: Path, dest: Path, errors: list[str]) -> list[Path]:
    base = dest.resolve()
    out: list[Path] = []
    total = 0
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = info.filename.replace("\\", "/")
                if name.startswith("__MACOSX/") or Path(name).name.startswith("."):
                    continue
                suffix = Path(name).suffix.lower()
                if suffix not in SUFFIXES or suffix == ".zip":
                    continue
                target = (base / name).resolve()
                if not target.is_relative_to(base):
                    errors.append(f"{path.name} 里有越界路径：{info.filename}")
                    continue
                total += info.file_size
                if total > MAX_UNZIP_BYTES:
                    errors.append(f"{path.name} 展开超过 {MAX_UNZIP_BYTES // 1024 // 1024} MB，已停止")
                    return out
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as fh:
                    shutil.copyfileobj(src, fh)
                out.append(target)
    except (zipfile.BadZipFile, OSError) as exc:
        errors.append(f"{path.name} 不是可读的压缩包：{exc}")
    return out


# ---------- XLSX ----------


def _col_index(ref: str) -> int:
    index = 0
    for ch in ref:
        if "A" <= ch <= "Z":
            index = index * 26 + (ord(ch) - 64)
        elif "a" <= ch <= "z":
            index = index * 26 + (ord(ch) - 96)
        else:
            break
    return max(0, index - 1)


def _num_text(value: float) -> str:
    if value == int(value) and abs(value) < 1e16:
        return str(int(value))
    return repr(value)


def _serial_date(value: float, date1904: bool) -> str:
    base = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
    try:
        stamp = base + dt.timedelta(days=value)
    except (OverflowError, ValueError):
        return _num_text(value)
    if stamp.hour or stamp.minute or stamp.second:
        return stamp.strftime("%Y-%m-%d %H:%M:%S")
    return stamp.strftime("%Y-%m-%d")


def _xml(zf: zipfile.ZipFile, member: str) -> ET.Element:
    if zf.getinfo(member).file_size > MAX_XML_BYTES:
        raise ValueError(f"{member} 超过 {MAX_XML_BYTES // 1024 // 1024} MB")
    blob = zf.read(member)
    if b"<!DOCTYPE" in blob[:4096]:
        raise ValueError(f"{member} 含 DTD，已拒绝")
    return ET.fromstring(blob)


def _shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = _xml(zf, "xl/sharedStrings.xml")
    except KeyError:
        return []
    out: list[str] = []
    for si in root.findall(f"{_NS}si"):
        parts: list[str] = []
        direct = si.find(f"{_NS}t")
        if direct is not None:
            parts.append(direct.text or "")
        for run in si.findall(f"{_NS}r"):
            node = run.find(f"{_NS}t")
            if node is not None:
                parts.append(node.text or "")
        out.append("".join(parts))
    return out


def _date_styles(root: ET.Element) -> set[int]:
    custom: dict[int, str] = {}
    numfmts = root.find(f"{_NS}numFmts")
    if numfmts is not None:
        for node in numfmts:
            try:
                custom[int(node.get("numFmtId") or 0)] = node.get("formatCode") or ""
            except ValueError:
                continue
    styles: set[int] = set()
    xfs = root.find(f"{_NS}cellXfs")
    if xfs is not None:
        for index, xf in enumerate(xfs.findall(f"{_NS}xf")):
            try:
                fmt = int(xf.get("numFmtId") or 0)
            except ValueError:
                continue
            code = custom.get(fmt, "")
            cleaned = re.sub(r'"[^"]*"', "", code)
            cleaned = re.sub(r"\[[^\]]*\]", "", cleaned)
            if fmt in _DATE_FORMAT_IDS or re.search(r"[ymdhs]", cleaned, re.IGNORECASE):
                styles.add(index)
    return styles


def _workbook(zf: zipfile.ZipFile) -> tuple[list[tuple[str, str]], bool]:
    root = _xml(zf, "xl/workbook.xml")
    rels: dict[str, str] = {}
    try:
        rel_root = _xml(zf, "xl/_rels/workbook.xml.rels")
        for rel in rel_root:
            rels[rel.get("Id") or ""] = rel.get("Target") or ""
    except KeyError:
        pass
    date1904 = False
    props = root.find(f"{_NS}workbookPr")
    if props is not None and str(props.get("date1904") or "").lower() in ("1", "true"):
        date1904 = True
    sheets: list[tuple[str, str]] = []
    node = root.find(f"{_NS}sheets")
    if node is not None:
        for sheet in node.findall(f"{_NS}sheet"):
            name = sheet.get("name") or ""
            target = rels.get(sheet.get(f"{_REL}id") or "", "")
            if target.startswith("/"):
                target = target.lstrip("/")
            elif not target.startswith("xl/"):
                target = "xl/" + target
            if name and target:
                sheets.append((name, target))
    return sheets, date1904


def _cell_text(cell: ET.Element, shared: list[str], dates: set[int], date1904: bool) -> str:
    kind = cell.get("t") or "n"
    node = cell.find(f"{_NS}v")
    raw = (node.text if node is not None else "") or ""
    if kind == "s":
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return ""
    if kind == "inlineStr":
        inline = cell.find(f"{_NS}is")
        if inline is None:
            return ""
        return "".join(t.text or "" for t in inline.iter(f"{_NS}t"))
    if kind == "str":
        return raw
    if kind == "b":
        return "TRUE" if raw.strip() == "1" else "FALSE"
    if kind == "e":
        return ""
    if not raw.strip():
        return ""
    try:
        number = float(raw)
    except ValueError:
        return raw
    style = cell.get("s")
    if style is not None and style.isdigit() and int(style) in dates:
        return _serial_date(number, date1904)
    return _num_text(number)


def _sheet_rows(zf: zipfile.ZipFile, member: str, shared: list[str], dates: set[int], date1904: bool) -> list[list[str]]:
    rows: list[list[str]] = []
    if zf.getinfo(member).file_size > MAX_XML_BYTES:
        raise ValueError(f"{member} 超过 {MAX_XML_BYTES // 1024 // 1024} MB")
    blob = zf.read(member)
    if b"<!DOCTYPE" in blob[:4096]:
        raise ValueError(f"{member} 含 DTD，已拒绝")
    context = ET.iterparse(io.BytesIO(blob), events=("start", "end"))
    try:
        _, root = next(context)
    except StopIteration:
        return rows
    for event, elem in context:
        if event != "end" or elem.tag != f"{_NS}row":
            continue
        values: list[str] = []
        for cell in elem.findall(f"{_NS}c"):
            ref = cell.get("r") or ""
            index = _col_index(ref) if ref else len(values)
            while len(values) < index:
                values.append("")
            text = _cell_text(cell, shared, dates, date1904)
            if len(values) == index:
                values.append(text)
            else:
                values[index] = text
        while values and not values[-1].strip():
            values.pop()
        if any(cell.strip() for cell in values):
            rows.append(values)
        root.clear()
        if len(rows) >= MAX_SHEET_ROWS:
            raise ValueError(f"{member} 超过 {MAX_SHEET_ROWS} 行，已停止")
    return rows


def _xlsx_tables(path: Path, label: str, out_dir: Path, used: set[str], errors: list[str]) -> list[dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    tables: list[dict] = []
    with zipfile.ZipFile(path) as zf:
        shared = _shared_strings(zf)
        try:
            dates = _date_styles(_xml(zf, "xl/styles.xml"))
        except KeyError:
            dates = set()
        sheets, date1904 = _workbook(zf)
        members = set(zf.namelist())
        for name, member in sheets:
            if member not in members:
                continue
            rows = _sheet_rows(zf, member, shared, dates, date1904)
            if not rows:
                continue
            stem = f"{_slug(path.stem)}__{_slug(name)}"
            target = out_dir / f"{stem}.csv"
            suffix = 2
            while target.name in used:
                target = out_dir / f"{stem}_{suffix}.csv"
                suffix += 1
            used.add(target.name)
            with target.open("w", encoding="utf-8-sig", newline="") as fh:
                csv.writer(fh).writerows(rows)
            tables.append(
                {
                    "name": label,
                    "sheet": name,
                    "path": str(target),
                    "rows": max(0, len(rows) - 1),
                    "cols": max(len(row) for row in rows),
                }
            )
    if not tables:
        errors.append(f"{label} 里没有可用的工作表")
    return tables


# ---------- DOCX ----------


def _docx_text(path: Path) -> str:
    with zipfile.ZipFile(path) as zf:
        root = _xml(zf, "word/document.xml")
    lines: list[str] = []
    for para in root.iter(f"{_W}p"):
        parts: list[str] = []
        for node in para.iter():
            if node.tag == f"{_W}t":
                parts.append(node.text or "")
            elif node.tag == f"{_W}tab":
                parts.append("\t")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


# ---------- 工具 ----------


def _slug(text: str, limit: int = 40) -> str:
    cleaned = re.sub(r"[^\w\u4e00-\u9fff.-]+", "_", text).strip("._")
    return (cleaned or "attachment")[:limit]
