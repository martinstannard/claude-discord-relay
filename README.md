# claude-discord-relay

Multi-session Discord bridge for Claude Code. One Discord bot, many Claude sessions — each scoped to specific channels or threads.

## Architecture

```
Discord ←→ Relay Daemon ←→ Bridge (Claude Session 1, channels: #prs)
                        ←→ Bridge (Claude Session 2, channels: #bugs)
                        ←→ Bridge (Claude Session 3, channels: *)
```

- **Relay Daemon** — long-lived process that owns the Discord bot connection and routes messages via Unix socket
- **MCP Bridge** — lightweight per-session MCP server that connects to the relay and exposes Discord tools to Claude Code
- **Relay CLI** — utility for managing the daemon

## Setup

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable: Message Content Intent, Server Members Intent, Presence Intent
4. Generate an invite URL with `bot` scope and these permissions: Send Messages, Read Message History, Manage Channels, Add Reactions, Manage Messages
5. Invite the bot to your server

### 2. Configure the relay

```bash
mkdir -p ~/.claude/channels/discord-relay
echo "DISCORD_BOT_TOKEN=your_token_here" > ~/.claude/channels/discord-relay/.env
```

### 3. Configure access control

```bash
# Create access.json (same format as the standard Discord plugin)
cat > ~/.claude/channels/discord-relay/access.json << 'EOF'
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {
    "*": {
      "requireMention": false,
      "allowFrom": []
    }
  },
  "pending": {}
}
EOF
```

### 4. Install dependencies

```bash
cd /path/to/claude-discord-relay
bun install
```

### 5. Start the relay

```bash
# Option A: Use the CLI
bun src/relay-ctl.ts start

# Option B: Run directly
bun src/relay-daemon.ts
```

### 6. Add the bridge to your MCP config

Add to your project's `.mcp.json` (or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "discord-relay": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/claude-discord-relay", "--shell=bun", "--silent", "start"],
      "env": {
        "DISCORD_RELAY_CHANNELS": "*",
        "DISCORD_RELAY_LABEL": "main"
      }
    }
  }
}
```

### 7. Connect Claude Code sessions

The bridge must be loaded as a **channel** (not a regular MCP server) for inbound notifications to work:

```bash
# Session subscribed to all channels (wildcard)
claude --dangerously-load-development-channels server:discord-relay

# To scope a session to specific channels, change the env in .mcp.json:
# "DISCORD_RELAY_CHANNELS": "123456789,987654321"

# For thread-scoped sessions:
# "DISCORD_RELAY_THREADS": "111222333"
```

## Tools

All the standard Discord tools are available through the bridge:

| Tool | Description |
|------|-------------|
| `reply` | Send a message to a Discord channel |
| `react` | Add an emoji reaction |
| `edit_message` | Edit a previously sent message |
| `fetch_messages` | Fetch recent channel history |
| `download_attachment` | Download message attachments |
| `create_channel` | Create a new text channel |
| `list_channels` | List all server channels |
| `create_thread` | Start a thread from a message |
| `pin_message` / `unpin_message` | Pin/unpin messages |
| `delete_channel` | Delete a channel |
| `move_channel` | Move a channel to a category |
| `set_channel_topic` | Update a channel's topic |

Plus relay-specific tools:

| Tool | Description |
|------|-------------|
| `subscribe` | Dynamically subscribe to more channels/threads |
| `unsubscribe` | Stop receiving from channels/threads |
| `relay_status` | View connected sessions and subscriptions |
| `spawn_session` | Launch a new Claude session from Discord |

## Relay CLI

```bash
bun src/relay-ctl.ts start    # Start the daemon
bun src/relay-ctl.ts stop     # Stop the daemon
bun src/relay-ctl.ts restart  # Restart
bun src/relay-ctl.ts status   # Show status and connected bridges
```

## How routing works

1. A Discord message arrives at the relay daemon
2. The relay checks access control (same rules as the standard plugin)
3. The relay looks up which bridges are subscribed to that channel/thread
4. The message is forwarded to all matching bridges
5. Each bridge delivers the message to its Claude session via MCP

**Subscription priority:**
- Explicit thread subscriptions take precedence
- Channel subscriptions include all threads in that channel
- Wildcard (`*`) matches any channel

## License

MIT
