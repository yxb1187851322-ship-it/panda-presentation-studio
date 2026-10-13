"""Produce a visual PDF from reviewed pages; never describe this output as vector text."""
import json
import sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
w = 841.8897637795
h = w * manifest["height"] / manifest["width"]
pdf = canvas.Canvas(sys.argv[2], pagesize=(w, h), pageCompression=1)
pdf.setTitle(manifest.get("title", "Booklet"))
pdf.setCreator("Panda Presentation Studio - reviewed-page PDF")
for image in manifest["pages"]:
    pdf.drawImage(ImageReader(image), 0, 0, width=w, height=h)
    pdf.showPage()
pdf.save()
