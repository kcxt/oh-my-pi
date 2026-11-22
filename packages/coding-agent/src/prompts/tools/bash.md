Persistent bash 5.3. The working directory resets each turn: use absolute paths or `cd` in the same command. `pty: true` for interactive programs.
Internal URIs work as paths in builtins, redirects and globs. In-process builtins, ahead of PATH: {{join builtins ", "}}.
View files with `read`, not `cat`/`sed -n`/`head`.
{{#if asyncEnabled}}
`async: true` returns now and delivers the result later, within `timeout` (default {{defaultTimeoutSec}}s); `timeout: 0` for watchers and long jobs.
{{/if}}
Don't truncate output by habit; long output is summarised and saved as an artifact.
{{#if hasLaunch}}
Services: unique `name` plus a `ready` check (`log` regex and/or `port`, both must match if both given; `host` 127.0.0.1, `ready.timeout` 30s by default). No `async`/`timeout`; `pty` defaults to true.
{{/if}}
{{#if autoBackgroundEnabled}}
A non-`pty` command still running after {{autoBackgroundSeconds}}s (or 1s before `timeout`) usually becomes background job `bg_N`, runs until `timeout`, and reports as a follow-up message. Never poll. Not when the user's terminal runs it or the job limit is reached.
{{/if}}
