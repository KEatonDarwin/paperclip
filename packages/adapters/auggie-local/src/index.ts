export const type = "auggie_local";
export const label = "Augment Code (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# auggie_local agent configuration

Adapter: auggie_local

Use when:
- You want Paperclip to run the Augment Code CLI (auggie) locally as the agent runtime
- You want to leverage Augment's proprietary codebase indexing and context engine
- You want to use auggie's multi-provider model support (Claude, GPT, Gemini, etc.)
- You want auggie session resume across heartbeats

Don't use when:
- You need webhook-style external invocation (use openclaw_gateway or http)
- auggie CLI is not installed on the machine
- You don't have an active Augment account or session

Core fields:
- cwd (string, optional): absolute working directory for the agent process (also used as auggie workspace root); created if missing
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- model (string, optional): auggie model id (e.g. "sonnet4.6", "gpt5.1", "gemini-3.1-pro-preview"); run \`auggie model list\` to see all available models
- promptTemplate (string, optional): run prompt template; supports {{agent.id}}, {{agent.name}}, {{run.id}} etc.
- command (string, optional): defaults to "auggie"
- extraArgs (string[], optional): additional CLI args passed to auggie
- maxTurns (number, optional): limit the number of agentic turns per run
- env (object, optional): KEY=VALUE environment variables

Authentication:
- auggie uses your local Augment session from ~/.augment/session.json
- Set AUGMENT_SESSION_AUTH env var to override (same JSON format as the session file)
- Run \`auggie login\` to authenticate if not already logged in

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Auggie automatically indexes the workspace root on first use (no confirmation prompt in --print mode)
- Sessions are resumed with --resume when the stored session workspace matches the current cwd
- Skills are injected via auggie's --rules flag; each skill's SKILL.md is passed as an additional rules file
- Runs are executed with: auggie --print --output-format json --instruction-file <tmpFile> --workspace-root <cwd>
- Run \`auggie model list\` to see all available models and their IDs
`;
