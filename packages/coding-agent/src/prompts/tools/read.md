Read files, directories, URLs and documents. Prefer it over a browser for static pages.

Line ranges go in the path; there is no offset or limit parameter. Repeat the selector on every call: a bare path always starts at the top.
- `:50-80` lines 50–80 · `:50` or `:50-` from line 50 on · `:50+20` 20 lines from 50 · `:-30` the last 30
- `:5-16,90-99` several ranges · `:19,59` single lines
- `:raw` returns the exact text: `:50-80:raw`, `:17:raw` (one line), `:17-:raw` (17 on). Without `:raw`, a single range also shows 1 line before and 3 after, and any range may add the opening or closing line of a block it cuts.

What comes back:
- A source file with no range: an outline of its declarations. Read the ranges its footer names; never guess what `…` or `..` hides.
{{#if IS_HL_MODE}}
- A file read starts with `[path#TAG]`: copy it as the `edit` header. Never invent a tag.
{{/if}}
- A directory: the full root listing; subdirectories stop at 12 entries (`… N more`), so read the subdirectory. Page long listings with `:N-M` or `:-N`.
- A URL: the page as markdown (`:raw` for the HTML). `host:port` needs a trailing `/`.
- PDFs and documents: extracted text. Notebooks: editable cells. Images: shown inline.
- These have their own selectors (read xd://read/sources first): SQLite, archives (ZIP, TAR, 7z, RAR and more), JSON/JSONL via a jq filter, {{#if BINARY_VIEWS}}executables, {{/if}}video, SVG as an image, merge conflicts.
