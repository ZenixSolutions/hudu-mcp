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
step below, and it means nothing you do in the next few minutes can read, alter
or delete a credential or delete a record — regardless of what you or a model
asks for. Note that Hudu's password scope is one switch covering every REST
action on passwords; this server splits reading from writing across two gates,
but the key does not.

Copy the key somewhere your MCP client can read it from. It is shown once.

## 2. Check the configuration (1 minute)

```bash
HUDU_BASE_URL=https://hudu.example.com \
HUDU_API_KEY=your-api-key \
npx -y @zenixsolutions/hudu-mcp --check
```

Expected output:

```
hudu-mcp: --check: reached Hudu 2.34.2 at https://hudu.example.com. GET /api_info
succeeded, so the base URL, the API key and network reachability are all confirmed.
```

`--check` calls `GET /api_info` with the key you gave it, so it tells you the
key works rather than only that it is present. A key that has been revoked or
rotated fails here, in one second, instead of turning into a run of empty lists
later. On failure it prints what went wrong and what to do about it, and exits
non-zero: 78 when the environment is wrong, 69 when the environment is fine and
Hudu refused or could not be reached.

What it cannot tell you is the key's **scope**. Password access, destructive
actions and exports are fixed when the key is created, and `/api_info` needs
none of them, so a key that passes here can still answer `401` on
`/asset_passwords`.

In a container build or anywhere without network access, add `--offline` to
validate the configuration syntax alone:

```bash
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... hudu-mcp --check --offline
```

That mode says plainly that nothing was verified, because nothing was.

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

A `401` has **two** causes and they look identical. Either the key was rejected
outright — deleted, mistyped, or called from outside the IP allowlist set on it
— or the key simply lacks the scope for that endpoint. The Hudu API documents no
`403` anywhere (`reference/spec-defects.md` A7), and a live Hudu 2.34.2 run
confirmed that a key created without password access answers `401` on
`/asset_passwords` and `/password_folders` (F5).

Tell them apart by how much fails. If **everything** fails, including
`hudu_get_api_info`, the key itself is the problem. If most tools work and one
family answers `401`, it is the key's scope — and scope is fixed when a key is
created, so reissuing the same kind of key changes nothing. Create a new key
with the capability you need.

A `404` is more awkward. It covers a record that does not exist, a record the
key's company scope hides, and an endpoint that does not exist on your Hudu
version. On 2.34.2 the response body distinguishes the first two from the third
— a missing record names its resource ("Network not found") where an unrouted
path answers a generic `{"status":404,"error":"Not Found"}` — but that is an
observation rather than a promise. `hudu_get_api_info` tells you the version;
check it when something behaves unexpectedly.

A get can also succeed and find nothing: `/companies/{id}` and `/articles/{id}`
answer `200` with an empty body for an id that does not exist. The get tools
report that as `found: false` with a notice naming the id, never as a record.

### The assistant says it has no tool for what you asked

That is a gate doing its job. Gated tools are not registered at all rather than
registered-and-refusing, so a model genuinely cannot see them and will report the
capability as unavailable rather than as forbidden.

Run `--list-tools` with the same environment the client uses. The `Withheld:`
section names each absent tool and the variable that would register it:

```
Withheld: 22
  hudu_delete_company: HUDU_ALLOW_DESTRUCTIVE is not set.
  ...
  hudu_create_password: HUDU_ALLOW_PASSWORD_WRITE is not set.
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
