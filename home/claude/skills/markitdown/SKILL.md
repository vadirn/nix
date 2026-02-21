---
name: markitdown
description: Converts files to Markdown using Microsoft's markitdown. Use when the user wants to read, extract, or analyze content from PDFs, DOCX, PPTX, XLSX, images, audio, HTML, CSV, JSON, XML, ZIP, YouTube URLs, or EPubs. Also use for PDF tasks like text/table extraction. For PDF manipulation (merge, split, rotate, fill forms, create), use pypdf/reportlab directly with uv run.
triggers:
  - convert to markdown
  - read this file
  - extract text from
  - what's in this file
  - markitdown
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
