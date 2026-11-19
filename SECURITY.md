# Security policy

## Supported versions

t3-autopilot has not had a tagged release yet. Security fixes land on `main`; once releases exist, the latest release gets them too.

| Version | Supported |
|---|---|
| `main` (0.1.x) | Yes |

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: [Security → Report a vulnerability](https://github.com/pablosalme/t3-autopilot/security/advisories/new). Include the commit or version, what an attacker could do, and the steps or input to reproduce it.

You should get an acknowledgement within 7 days. This project is maintained in spare time, so a fix can take longer; you will be kept informed, and credited in the advisory unless you prefer not to be.

## Scope

t3-autopilot is a local stdio MCP server. It makes no network requests, reads its policy from and writes its log to `~/.t3-autopilot` (or `$T3_AUTOPILOT_HOME`), and never reads provider credentials or T3 Code's own files. Reports in scope include, for example:

- input (an `orchestrator_capabilities` output, a policy file, a log line) that makes the server crash, hang, write outside its data directory or run code;
- data the server should not store ending up in `log.jsonl`;
- a vulnerable dependency that affects t3-autopilot, or a problem in the packaged files.

Out of scope: what the orchestrator or child agents do with a recommendation, and vulnerabilities in T3 Code, the agent CLIs or the providers; please report those to their own projects.
