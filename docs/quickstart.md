# Quickstart

Five minutes from nothing to a working tool call. If you have not yet decided
between this server and the one Hudu ships in the product, read the comparison in
the [README](../README.md#before-you-install-this-look-at-hudus-own-mcp-server)
first.

You need Node.js 20 or newer and access to a Hudu instance.

## 1. Create an API key (2 minutes)

In Hudu, go to **Admin → Basic Information → API Keys** and create a key.

Hudu fixes a key's scope at creation and does not let you change it afterwards.
For this walkthrough, create the key with **password access off, destructive
actions off and export capability off**. That combination is enough for every
step below, and it means nothing you do in the next few minutes can read a
credential or delete a record — regardless of what you or a model asks for.

Copy the key somewhere your MCP client can read it from. It is shown once.

## 2. Check the configuration (1 minute)

```bash
HUDU_BASE_URL=https://hudu.example.com \
HUDU_API_KEY=your-api-key \
npx -y @zenixsolutions/hudu-mcp --check
```

Expected output:

```
hudu-mcp: configuration is valid.
```

`--check` validates the environment. It does not contact Hudu. To confirm the
key and URL actually work, the first tool call in step 4 is the test.

Now look at what would be registered:

```bash
HUDU_BASE_URL=https://hudu.example.com \
HUDU_API_KEY=your-api-key \
HUDU_READ_ONLY=1 \
npx -y @zenixsolutions/hudu-mcp --list-tools
```

That prints 40 tool names, then a `Withheld:` section listing the 49 that are not
being registered and the reason for each. Reading this output is the fastest way
to understand the gates, and it is worth doing once before you go any further.

## 3. Configure your MCP client (1 minute)

Add the server to your client's MCP configuration. The shape below is the
standard stdio form:

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

Client-specific file locations and alternatives to `npx` are in
[installation.md](installation.md). Restart the client so it launches the server.

## 4. Make a tool call (1 minute)

Ask the assistant for the Hudu version:

> Use the Hudu tools to tell me what version this instance is running.

It should call `hudu_get_api_info`, which takes no arguments and returns
`version` and `date`. That single call proves four things at once: the client
launched the process, the base URL resolves, the key authenticates, and the
transport is working.

Then ask for something real:

> Find the company "Contoso" in Hudu and tell me how many assets it has
> documented.

The expected sequence is `hudu_list_companies` with `search: "Contoso"` to get
the company id, then `hudu_list_assets` with that `company_id`. Note what the
assistant says about the count — see
[Pagination](user-guide.md#pagination-and-why-a-full-page-means-nothing) in the
user guide, because "how many" is a question this API cannot answer directly.

## The three things most likely to go wrong

### The server exits immediately and the client says it failed to start

Configuration was rejected. The process writes the problem to **stderr** and
exits with code 78. Run the same environment through `--check` in a terminal to
see it:

```
hudu-mcp: Invalid configuration:
  - HUDU_BASE_URL must be an absolute URL, for example https://hudu.example.com
  - HUDU_API_KEY must not be empty
```

Every problem is listed at once. Most MCP clients show only "server exited" or a
generic connection failure, so the terminal is where the actual message is. Two
non-obvious causes:

- `HUDU_READ_ONLY` and `HUDU_ALLOW_DESTRUCTIVE` both set. This is rejected
  deliberately, not silently resolved.
- `HUDU_RATE_LIMIT_PER_MINUTE` above 300. 300 per minute is the limit Hudu
  documents, and the configuration will not accept a client-side ceiling above
  the server-side one.

### Every call comes back 401, or 404 for records you know exist

Both are usually the API key rather than the request.

A `401` means the key was rejected: it has been deleted, it was mistyped, or the
calling machine is outside the IP allowlist set on the key. The error text says
so and tells you it cannot be fixed by changing tool arguments — it is a server
configuration problem.

A `404` is more awkward. The Hudu API documents no `403` anywhere
(`reference/spec-defects.md` A7), so a key that lacks a scope does not get told
"forbidden": it gets whatever the endpoint returns instead, most often a `404`
that is indistinguishable from a record that does not exist. If
`hudu_list_companies` works but `hudu_list_passwords` returns nothing on a tenant
you know has credentials in it, suspect a key created without password access
before you suspect empty data. The same applies to a company-scoped key: every
company except the scoped one reads as missing.

Hudu also answers `404` for an unrouted path, so an endpoint that does not exist
on your Hudu version looks identical to an empty result. `hudu_get_api_info`
tells you the version; check it when something behaves unexpectedly.

### The assistant says it has no tool for what you asked

That is a gate doing its job. Gated tools are not registered at all rather than
registered-and-refusing, so a model genuinely cannot see them and will report the
capability as unavailable rather than as forbidden.

Run `--list-tools` with the same environment the client uses. The `Withheld:`
section names each absent tool and the variable that would register it:

```
Withheld: 19
  hudu_delete_company: HUDU_ALLOW_DESTRUCTIVE is not set.
  ...
  hudu_reveal_password: HUDU_ALLOW_PASSWORD_REVEAL is not set.
  hudu_start_company_export: HUDU_ALLOW_EXPORTS is not set.
```

Two things to know before you set one of those variables. First, the flag only
governs this server; the API key must also have been created with the matching
scope, or Hudu will refuse the call anyway. Second, the flags are read once at
startup, so changing one means restarting the server — which for most clients
means restarting the client.

## Where to go next

- [user-guide.md](user-guide.md) — real workflows and the tool sequence for each
- [tool-reference.md](tool-reference.md) — all 89 tools with arguments and gates
- [security.md](security.md) — what to think about before enabling a gate
- [limitations.md](limitations.md) — questions this API cannot answer
