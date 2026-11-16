# Security

Report a vulnerability to security@clonvo.com. Please don't open a public issue for it.

## What the CLI does with your credentials

- `clonvo login` uses OAuth 2.1 with PKCE and a loopback redirect on `127.0.0.1`. It checks `state` and `iss` on the way back, and the page it serves echoes nothing from the request.
- The sign-in is saved to `cli-credentials.json` in your config folder, created with mode 0600 and replaced atomically. The CLI refuses a folder other users can write to.
- Tokens and keys are only sent to the API origin, over https (plain http only to localhost), and never follow a redirect.
- Each sign-in is its own connection: `clonvo logout` ends it on Clonvo's side, and you can end any of them under Settings → Connected apps.
- The browser is opened without a shell. Text from the network is stripped of control characters before it reaches your terminal.
- Files and standard input are read only where you ask: `--args @file.json`, `--args -`, and JSON options given `@file` or `-`. Text arguments are always sent as typed.
- The package has no runtime dependencies and no install scripts.
