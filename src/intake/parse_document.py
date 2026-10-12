"""Bounded, text-only parser. Never follows external relationships or invokes Office."""
import json
import re
import sys
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

MAX_CHARACTERS = 100_000
MAX_PAGES = 80
MAX_ZIP_ENTRIES = 4000
MAX_ZIP_EXPANDED = 128 * 1024 * 1024
MAX_ZIP_MEMBER = 16 * 1024 * 1024


def output(status, text="", warnings=None, scope=None, format=None):
    return {"kind": "document", "status": status, "text": text, "warnings": warnings or [], "readScope": scope, "format": format}


def xml(zip_file, name):
    data = zip_file.read(name)
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML contains forbidden declarations")
    return ET.fromstring(data)


def checked_zip(file):
    zf = zipfile.ZipFile(file)
    entries = zf.infolist()
    if len(entries) > MAX_ZIP_ENTRIES or sum(x.file_size for x in entries) > MAX_ZIP_EXPANDED:
        raise ValueError("Archive exceeds safe expansion limits")
    for entry in entries:
        name = entry.filename.replace("\\", "/")
        p = PurePosixPath(name)
        if p.is_absolute() or ".." in p.parts or ":" in name:
            raise ValueError("Unsafe archive member path")
        if entry.flag_bits & 1 or entry.file_size > MAX_ZIP_MEMBER:
            raise ValueError("Encrypted or oversized archive member")
        if entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200:
            raise ValueError("Archive compression ratio exceeds safety limit")
        if "vbaproject" in name.lower() or name.lower().endswith((".exe", ".dll")):
            raise ValueError("Macro or executable content is not supported")
    return zf


def parse_office(file):
    with checked_zip(file) as zf:
        names = set(zf.namelist())
        if "[Content_Types].xml" not in names:
            return output("unsupported", warnings=["压缩包不是可识别的 DOCX/PPTX；原件已保存。"])
        content_types = zf.read("[Content_Types].xml").lower()
        if b"macroenabled" in content_types or b"vbaproject" in content_types:
            return output("unsupported", warnings=["含宏 Office 文档不解析；原件已保存，宏没有执行。"])
        # External relationships are deliberately ignored. Paragraphs are extracted as text only.
        if "word/document.xml" in names:
            root = xml(zf, "word/document.xml")
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            paragraphs = ["".join(t.text or "" for t in p.findall(".//w:t", ns)).strip() for p in root.findall(".//w:p", ns)]
            paragraphs = [p for p in paragraphs if p]
            combined = "\n\n".join(paragraphs)
            text = combined[:MAX_CHARACTERS]
            partial = len(combined) > MAX_CHARACTERS
            warnings = ["已读取 DOCX 主文档段落和表格文字；未读取页眉页脚、批注、嵌入对象或图片，也未识别固定版式。"]
            if partial:
                warnings.append("正文仅读取前 100000 个字符。")
            return output("partial" if partial else "ready", text, warnings, {"mode": "main_document_text", "paragraphsFound": len(paragraphs), "charactersRead": len(text), "totalCharacters": len(combined), "complete": not partial, "layoutAnalyzed": False}, "docx")
        if "ppt/presentation.xml" in names:
            ns = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "a": "http://schemas.openxmlformats.org/drawingml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
            rel_path = "ppt/_rels/presentation.xml.rels"
            if rel_path not in names:
                raise ValueError("Presentation relationship index is missing")
            relationships = {}
            for relationship in xml(zf, rel_path):
                if relationship.attrib.get("TargetMode", "").lower() == "external":
                    continue
                target = relationship.attrib.get("Target", "").replace("\\", "/")
                if target.startswith("/ppt/"):
                    target = target[1:]
                else:
                    target = "ppt/" + target
                if ".." not in PurePosixPath(target).parts:
                    relationships[relationship.attrib.get("Id")] = target
            ids = xml(zf, "ppt/presentation.xml").findall(".//p:sldId", ns)
            sections, characters = [], 0
            blank_pages = []
            read = 0
            limited = False
            for index, element in enumerate(ids[:MAX_PAGES], 1):
                if characters >= MAX_CHARACTERS:
                    limited = True
                    break
                slide_path = relationships.get(element.attrib.get("{" + ns["r"] + "}id"))
                if slide_path not in names:
                    raise ValueError("A slide relationship cannot be resolved")
                root = xml(zf, slide_path)
                paragraphs = ["".join(t.text or "" for t in p.findall(".//a:t", ns)).strip() for p in root.findall(".//a:p", ns)]
                if not any(paragraphs):
                    blank_pages.append(index)
                chunk = f"[原稿第 {index} 页]\n" + "\n".join(p for p in paragraphs if p)
                available = MAX_CHARACTERS - characters
                if len(chunk) > available:
                    limited = True
                chunk = chunk[:available]
                sections.append(chunk)
                characters += len(chunk) + 2
                read += 1
            text = "\n\n".join(sections)
            partial = limited or read < len(ids) or bool(blank_pages)
            warnings = ["按 PPTX 实际页序提取原生文字；未读取母版、备注、图表数据、嵌入对象或图片文字，未识别版面锁定范围。"]
            if limited or read < len(ids):
                warnings.append("本次最多读取 80 页 / 100000 字符；剩余内容保留在原件中。")
            if blank_pages:
                warnings.append("部分页面没有可提取的原生文字；尚未识别页面图片内容。")
            if read and len(blank_pages) == read:
                text = ""
            return output("partial" if partial else "ready", text, warnings, {"mode": "slide_text", "pagesRead": read, "totalPages": len(ids), "charactersRead": len(text), "pagesWithoutText": blank_pages, "complete": not partial, "layoutAnalyzed": False}, "pptx")
        return output("unsupported", warnings=["该 Office 压缩包不是可识别的 DOCX/PPTX。"])


def parse_pdf(file):
    try:
        from pypdf import PdfReader
        import pypdf.filters as pdf_filters
    except ImportError:
        return output("pending", warnings=["缺少 pypdf 依赖，PDF 原件已保存，正文尚未读取。"], format="pdf")
    # Reduce the library's stream inflation limits before any content decoding.
    for limit_name in ("MAX_DECLARED_STREAM_LENGTH", "MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH", "LZW_MAX_OUTPUT_LENGTH", "RUN_LENGTH_MAX_OUTPUT_LENGTH", "ZLIB_MAX_OUTPUT_LENGTH"):
        if hasattr(pdf_filters, limit_name):
            setattr(pdf_filters, limit_name, MAX_ZIP_MEMBER)
    reader = PdfReader(file, strict=False)
    if reader.is_encrypted:
        return output("unsupported", warnings=["加密 PDF 尚未解析，原件已保存。"], format="pdf")
    total = len(reader.pages)
    sections, blank_pages = [], []
    characters = 0
    read = 0
    limited = False
    for index in range(min(total, MAX_PAGES)):
        if characters >= MAX_CHARACTERS:
            limited = True
            break
        page = reader.pages[index]
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > MAX_ZIP_MEMBER:
            return output("unsupported", warnings=["PDF 页面内容超过安全读取范围；原件已保留。"], format="pdf")
        body = page.extract_text() or ""
        if not body.strip():
            blank_pages.append(index + 1)
        chunk = f"[原稿第 {index + 1} 页]\n{body.strip()}"
        remaining = MAX_CHARACTERS - characters
        if len(chunk) > remaining:
            limited = True
        sections.append(chunk[:remaining])
        characters += len(sections[-1]) + 2
        read += 1
    text = "\n\n".join(sections)
    partial = limited or read < total or bool(blank_pages)
    warnings = ["仅提取 PDF 内嵌文字；未做 OCR、页面渲染或固定版式识别。"]
    if blank_pages:
        warnings.append(f"第 {', '.join(map(str, blank_pages))} 页未发现可提取文字，可能是扫描页或图像页。")
    if limited or read < total:
        warnings.append("本次最多读取 80 页 / 100000 字符；剩余内容保留在原件中。")
    # Page markers alone are not source content and must not become invented slide text.
    if read and len(blank_pages) == read:
        text = ""
    return output("partial" if partial else "ready", text, warnings, {"mode": "embedded_text", "pagesRead": read, "totalPages": total, "charactersRead": len(text), "pagesWithoutText": blank_pages, "complete": not partial, "ocrPerformed": False, "layoutAnalyzed": False}, "pdf")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        result = parse_pdf(sys.argv[1]) if sys.argv[2] == "pdf" else parse_office(sys.argv[1])
    except Exception:
        result = output("unsupported", warnings=["文档结构损坏、内容受限或超出安全解析范围；原件已保存，未执行任何宏或外部引用。"])
    print(json.dumps(result, ensure_ascii=False))
