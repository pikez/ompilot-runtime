# ompilot-runtime

Signed Agent Runtime releases for Ompilot.

The scheduled workflow checks the npm `latest` tag for
`@oh-my-pi/pi-coding-agent` every six hours. A new version is published only
after the bundled adapter passes its import probe and read-only RPC contract.

Release artifacts contain:

- The selected OMP SDK dependency graph
- A platform-specific Bun runtime and `pi-natives` package
- Ompilot's SDK/config worker adapters
- A signed release index consumed by Ompilot

The signing private key is stored only in the repository's
`OMPILOT_RUNTIME_SIGNING_KEY` Actions secret.
