# Installation

## Requirements

- **Node.js 20 or newer.** `package.json` declares `"node": ">=20.0.0"`, and CI
  runs the full validation suite on Node 20 and Node 22.
- **A Hudu instance** reachable from the machine that runs this server, over HTTP
  or HTTPS.
- **A Hudu API key**, from Admin → Basic Information → API Keys. Its scope is
  fixed at creation; see [the README](../README.md#getting-an-api-key) before you
  create one.

There is no database, no cache and no state on disk. The process holds the key in
memory and makes HTTP requests; that is all.

## Option 1: npx (no install)

```bash
npx -y @zenixsolutions/hudu-mcp --version
```

This is what most MCP client configurations use. `npx` fetches the package on
first run and caches it. The trade-off is that `npx` may fetch a newer version
later without you asking; pin it if that matters:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "npx",
      "args": ["-y", "@zenixsolutions/hudu-mcp@0.1.0"],
      "env": {
        "HUDU_BASE_URL": "https://hudu.example.com",
        "HUDU_API_KEY": "your-api-key"
      }
    }
  }
}
```

Pre-1.0 the tool surface is not stable — a minor version may add, rename or
remove tools — so pinning is reasonable for anything you depend on.

## Option 2: global install

```bash
npm install -g @zenixsolutions/hudu-mcp
hudu-mcp --version
```

The package installs one executable, `hudu-mcp`. Use it in a client
configuration by giving the command directly:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "hudu-mcp",
      "env": {
        "HUDU_BASE_URL": "https://hudu.example.com",
        "HUDU_API_KEY": "your-api-key"
      }
    }
  }
}
```

Some clients do not inherit your shell's `PATH`. If the client reports that the
command was not found, use the absolute path from `which hudu-mcp` (or
`where hudu-mcp` on Windows) instead of the bare name.

## Option 3: from source

For working on the server itself, or for running a build you have reviewed:

```bash
git clone https://github.com/ZenixSolutions/hudu-mcp.git
cd hudu-mcp
npm ci
npm run build
node dist/index.js --version
```

`npm run validate` runs the same steps CI does: typecheck, lint, format check,
tests and build. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution
lifecycle and for which of those steps are enforced.

Point a client at the built entry point by absolute path:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "node",
      "args": ["/absolute/path/to/hudu-mcp/dist/index.js"],
      "env": {
        "HUDU_BASE_URL": "https://hudu.example.com",
        "HUDU_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Local development without a container

There is no Docker image and no container is needed. The dependency set is
deliberately small — `@modelcontextprotocol/sdk` and `zod` at runtime — so a
checkout, `npm ci` and a Node 20 or 22 runtime is the whole environment.

The server reads configuration from `process.env` only. It does **not** load a
`.env` file: there is no `dotenv` dependency and nothing in `src/` reads from
disk. `.env.example` exists to be copied and then sourced by you.

```bash
cp .env.example .env      # then edit it; .env is gitignored
```

Load it whichever way suits you:

```bash
# Node's own env-file support (Node 20.6 or newer)
node --env-file=.env dist/index.js --list-tools

# or export it into the shell first
set -a && . ./.env && set +a
node dist/index.js --list-tools
```

Keep the key out of shell history and out of process listings — prefer a file or
your client's environment configuration over typing
`HUDU_API_KEY=... node dist/index.js` at an interactive prompt.

Contract tests are opt-in and issue real requests against the instance in your
environment. They are never run by CI or by `npm test`:

```bash
HUDU_CONTRACT_TESTS=1 npm run test:contract
```

Use a non-production instance, or a key scoped to a single test company.

## Client configuration

The server speaks **stdio only**. Any MCP client that can launch a local process
and speak the protocol over its standard input and output can run it; a client
that only connects to remote HTTP endpoints cannot. See
[compatibility.md](compatibility.md).

### Claude Desktop

Edit the MCP configuration file from **Settings → Developer → Edit Config**,
which opens `claude_desktop_config.json`. Add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "npx",
      "args": ["-y", "@zenixsolutions/hudu-mcp"],
      "env": {
        "HUDU_BASE_URL": "https://hudu.example.com",
        "HUDU_API_KEY": "your-api-key",
        "HUDU_READ_ONLY": "1"
      }
    }
  }
}
```

Restart the application. The server's startup diagnostics go to stderr, which
Claude Desktop records in its MCP log files — that is where to look if the server
does not appear.

### Claude Code

Either add it from the command line:

```bash
claude mcp add hudu \
  --env HUDU_BASE_URL=https://hudu.example.com \
  --env HUDU_API_KEY=your-api-key \
  --env HUDU_READ_ONLY=1 \
  -- npx -y @zenixsolutions/hudu-mcp
```

Or commit a project-scoped `.mcp.json` at the repository root, using the same
`mcpServers` block shown above. Do not put a real key in a file you commit;
reference an environment variable your shell already holds, or configure the
server at user scope instead.

### Any other stdio client

The three things a client needs are the command (`npx`, `hudu-mcp` or `node`),
its arguments, and the environment. Everything else is protocol.

## Verifying an installation

Three flags run without contacting Hudu:

| Command              | What it proves                                              | Exit code                         |
| -------------------- | ----------------------------------------------------------- | --------------------------------- |
| `hudu-mcp --version` | The package is installed and executable. Prints `0.1.0`.    | 0                                 |
| `hudu-mcp --help`    | Prints usage, including every environment variable.         | 0                                 |
| `hudu-mcp --check`   | The configuration in the environment is valid and complete. | 0, or 78 on invalid configuration |

`--version` and `--help` need no environment at all. `--check` needs
`HUDU_BASE_URL` and `HUDU_API_KEY`, and validates them without making a request:

```bash
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... hudu-mcp --check
hudu-mcp: configuration is valid.
```

A fourth flag builds the full tool set and prints it, which requires valid
configuration but still makes no HTTP request:

```bash
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... hudu-mcp --list-tools
```

Each line is the tool name, its operation class, and its title, followed by a
count and then the withheld tools with the reason for each. Expect 70 registered
and 19 withheld with default settings, 40 and 49 under `HUDU_READ_ONLY=1`, and 89
with `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_EXPORTS` and
`HUDU_ALLOW_PASSWORD_REVEAL` all set.

To prove the key and URL actually work, call `hudu_get_api_info` from your client
once it is connected. It takes no arguments and needs no permissions beyond a
valid key.

## Uninstalling

- npx: nothing to uninstall. Remove the entry from your client configuration and
  clear the npm cache if you want the download gone.
- Global install: `npm uninstall -g @zenixsolutions/hudu-mcp`.
- From source: delete the checkout.

In all three cases, delete the API key in Hudu as well. Removing the client
configuration stops this server from using the key; it does not stop anything
else that has a copy of it.
