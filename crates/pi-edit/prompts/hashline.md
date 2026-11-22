Edit existing files by line number; create files with `write`.

Each file's section starts with `[PATH#TAG]`, TAG being the 4-hex tag from your latest `read`/`search` of it. Ops use that read's line numbers; earlier ops never shift them.

<ops>
Only `:` ops take a `+` body, of any length.
`PUT N.=M:` replace lines N–M (`N.=N`: one line).
`PUT <N:` / `PUT >N:` insert before / after N; `<1` top, `>$` end.
`CUT N.=M` delete N–M (never an empty PUT).
`N*` instead of `N.=M` is the block opening at N (a function, class or Markdown section): `PUT N*:`, `CUT N*`, `PUT >N*:` (insert after it).
Move: `CUT N.=M @x` (or `CUT N* @x`), then `PUT <K @x` / `PUT >K @x` at a gap or `PUT K.=L @x` / `PUT K* @x` over lines, in any file's section. No body; registers persist across calls.
`REM` delete the file; `MV DEST` rename it after its other ops (quote spaced paths).
</ops>

<rules>
- Body: `+` then the exact line, indentation included; lone `+` is blank; text starting `+`/`-` is `++…`/`+-…`. Never send `-` lines or unchanged context.
- Use only lines the read showed; `…`, `..`, `N-M:` summaries and lines outside the window are unread.
- Ranges cover only changed lines and never start or end mid-expression. Separate changes, separate ops; add lines by inserting.
- `N*` names a block's first line (first decorator, attribute or doc comment), never an inner or closing one; one statement takes a range. To add inside a block, insert before its closer.
- A Markdown heading's block runs to the next heading of equal or higher level; end an inserted section with a lone `+`.
- Every edit changes the tag and numbers: reuse the header from its response, or re-read. Surprised by a result? Re-read.
- Don't restyle unrelated code.
</rules>

<example>
```
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(name)
[PLAN.md#3C4D]
PUT >2:
+- task
```
</example>
