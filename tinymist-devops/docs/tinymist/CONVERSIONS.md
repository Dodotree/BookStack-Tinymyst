# LaTEX, MathML

## To Typst

- [Pandoc](https://pandoc.org/): best general-purpose pipeline tool.
Good when your source is Markdown/HTML/Docx/LaTeX and you want Typst output.
Typical usage: pandoc input.html -t typst -o output.typ.

- LaTeX/TeX-math converters (for math-heavy content):
Tools in this space (e.g. texmath-based workflows, mitex ecosystem) can help convert formulas to Typst math syntax.

- Custom XML/XSLT pipeline (for structured XML/MathML):
Most teams do: XML/MathML → intermediate Markdown/LaTeX/AST → Typst, because direct conversion quality is usually inconsistent.

- **`texmath` ecosystem**
  - Purpose: parse/convert math between formats like LaTeX math, MathML, OMML, etc.
  - For Typst: usually used as an **intermediate normalizer** (e.g., MathML → TeX-like math), then another step maps to Typst math syntax.
  - Best in pipelines where your source is mixed/dirty and you need robust parsing first.

- **`mitex` ecosystem**
  - Purpose: convert TeX/LaTeX math into Typst-friendly math (used in tools like Underleaf in `typst.ts` docs).
  - For Typst: this is the more direct option when your formulas are LaTeX/TeX.

How to use them for Typst conversion in practice:

- **LaTeX-heavy source**
  1. Extract math nodes (`$...$`, `$$...$$`, environments).
  2. Convert each math fragment with `mitex`.
  3. Replace original fragments in your document template.
  4. Emit `.typ` and compile.

- **MathML/XML-heavy source**
  1. Convert MathML to TeX first (e.g., `pmml2tex`/similar).
  2. Convert TeX math to Typst math with `mitex`.
  3. Reinsert into your generated Typst document.

- **Pandoc-style workflow**
  1. Parse whole document (HTML/Docx/XML-derived).
  2. In math AST nodes, run conversion chain (`texmath` normalize → `mitex` to Typst).
  3. Render final Typst text.

These tools solve mostly **math fragments**; headings, tables, citations, and layout still need separate mapping to Typst.

## From Typst, Tinymist export

- Official renderer outputs: `PDF`, `PNG`, `SVG`
- Other outputs: `HTML`, `Markdown` (via typlite), `TeX`, `Text`
- Structured extraction: `Query` output (e.g. JSON/YAML/TXT)

If you’re driving Tinymist from your own LSP client

- Call export commands (typically via `workspace/executeCommand`) with:
  - command: `tinymist.exportPdf` / `tinymist.exportPng` / `tinymist.exportSvg` / `tinymist.exportHtml` / `tinymist.exportMarkdown` / `tinymist.exportTeX` / `tinymist.exportText` / `tinymist.exportQuery`
  - args: `[filePath, options]`
- Useful options:
  - PDF: `pages`, `pdfStandard`, `noPdfTags`
  - PNG/SVG: `pages`, `pageNumberTemplate`, `merge`
  - Markdown/TeX: `processor`, `assetsPath`
  - Query: `selector`, `format`, `field`, `one`, `pretty`

Tinymist export calls go through workspace/executeCommand with this argument shape:

- command: tinymist.exportXxx
- arguments: [absoluteInputPath, exportOptionsObject, actionOptionsObject]

Examples you can send:

- PDF
  { "command":"tinymist.exportPdf", "arguments":["C:/work/main.typ", { "pages":["1-3"], "pdfStandard":["a-2b"], "noPdfTags":false }, { "write":true, "open":false }] }

- SVG merged
  { "command":"tinymist.exportSvg", "arguments":["C:/work/main.typ", { "merge":{}, "pages":["1-5"] }, { "write":true, "open":true }] }

- Markdown
  { "command":"tinymist.exportMarkdown", "arguments":["C:/work/main.typ", { "assetsPath":"C:/work/out-assets" }, { "write":true, "open":false }] }

- TeX with processor
  { "command":"tinymist.exportTeX", "arguments":["C:/work/main.typ", { "processor":"@local/ieee-tex:0.1.0" }, { "write":true, "open":false }] }

- Query to JSON
  { "command":"tinymist.exportQuery", "arguments":["C:/work/main.typ", { "format":"json", "selector":"<label-or-selector>", "pretty":true }, { "write":true, "open":false }] }

About processor:

- Not required for SVG, PNG, PDF, HTML, Text, Query.
- Optional for Markdown and TeX. In practice, TeX export is usually much better with a processor.
- Special case: exportPdf on a markdown input path can also use processor.
- You can get/create one as:
  - A Typst processor file in your project (for example /ieee-tex.typ),
  - Or a local/preview package reference (for example @local/ieee-tex:0.1.0).
  - Reference example docs: typlite.typ and README.md

Example of processor:
tinymist\docs\tinymist\feature\typlite.typ
