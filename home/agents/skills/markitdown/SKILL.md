---
name: markitdown
description: Convert files to Markdown via Microsoft's markitdown (uvx). Use for PDFs, DOCX, PPTX, XLSX, images, audio, HTML, CSV, JSON, XML, ZIP, YouTube URLs, EPubs. For PDF manipulation use pypdf/reportlab.
---

# markitdown

Converts files to Markdown via `uvx`.

## Usage

```bash
uvx --with 'markitdown[all]' markitdown <file> -o output.md
```

Reads from stdin too:

```bash
cat file.docx | uvx --with 'markitdown[all]' markitdown
```

## Supported formats

PDF, DOCX, PPTX, XLSX, XLS, images (EXIF + OCR), audio (EXIF + transcription), HTML, CSV, JSON, XML, ZIP (iterates contents), YouTube URLs, EPubs.

## When to use

- User wants to **read** content from a binary file (PDF, DOCX, PPTX, XLSX, images, audio, etc.)
- User provides a YouTube URL and wants a transcript
- User wants to extract text/tables from a file for analysis

## When NOT to use

- PDF manipulation (merge, split, rotate, fill forms, create) — use `pypdf`/`reportlab` with `uv run`
- Web page scraping — use `firecrawl`
- Files Claude can read natively (plain text, code, Markdown)
