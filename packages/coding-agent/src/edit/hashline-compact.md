Edit existing files by line number; create new files with `write`.

Each file's section starts with `[PATH#TAG]`: TAG is the 4-hex tag from your latest `read`/`search` of that file. All ops in a section use that read's line numbers; earlier ops never shift them.

Ops (only `:` ops take a `+` body):
- `PUT N.=M:` replace lines N–M; any body length. `PUT <N:` / `PUT >N:` insert before / after N; `>$` appends.
- `CUT N.=M` delete N–M.
- `N*` in place of `N.=M` is the block opening at N: `PUT N*:`, `CUT N*`, `PUT >N*:` (insert after it).
- Move: `CUT N.=M @x`, then `PUT <K @x` / `PUT >K @x` in any file's section; no body.
- `REM` delete the file; `MV DEST` rename it.

Body: `+` then the exact line with indentation; lone `+` is blank; text starting `+`/`-` is `++…`/`+-…`. No `-` lines, no unchanged context.

Use only lines the read showed (`…` is unread). Ranges cover only changed lines, never start or end mid-expression; `N*` names a block's first line. Each edit changes the tag: use the header from its response or re-read.
