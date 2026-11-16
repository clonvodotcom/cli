# Changelog

This project follows [Semantic Versioning](https://semver.org): a breaking change to commands, flags, output or exit codes means a new major version.

## 1.0.0

First release.

- `clonvo login`: browser sign-in with OAuth 2.1, PKCE and a loopback redirect. `--with-key` saves an API key instead; `CLONVO_API_KEY` overrides both.
- Every Clonvo tool is a command, with arguments and `--help` built from its schema. Long-running tools are followed to the end; Ctrl-C cancels them.
- `whoami`, `balance`, `tools`, `jobs get|cancel`, `logout`.
- Shell completion for bash, zsh and fish.
- `--debug`, `--no-color`, `NO_COLOR` and `FORCE_COLOR`.
- A daily update check against npm, off in CI and with `CLONVO_NO_UPDATE_NOTIFIER=1`.
- No telemetry.
