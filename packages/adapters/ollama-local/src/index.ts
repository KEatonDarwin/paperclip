export const type = "ollama_local";
export const label = "Ollama (local)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ollama_local agent configuration

Adapter: ollama_local

Use when:
- You want a free, local-model-powered agent running on Ollama
- You want to handle heartbeats with a local model (gemma4, llama3.1, qwen2.5-coder, etc.)
- You want a cost-free triage or worker agent that escalates to paid models when needed
- Ollama is running locally or on the network

Don't use when:
- You need file system access or IDE integration (use claude_local, codex_local, etc.)
- Complex multi-step coding tasks requiring persistent context (use claude_local)
- Ollama is not available on the network

Core fields:
- baseUrl (string, required): Ollama server URL, e.g. http://192.168.1.21:11434
- model (string, required): Ollama model name, e.g. gemma4:latest, llama3.1:8b, qwen2.5-coder:7b
- maxTurns (number, optional): maximum tool-call rounds per heartbeat, default 20
- timeoutSec (number, optional): per-Ollama-call timeout in seconds, default 60
- systemPromptExtra (string, optional): additional instructions appended to the system prompt

Operational fields:
- No subprocess is spawned — the adapter communicates directly with Ollama's HTTP API.
- The agent has two tools: call_paperclip_api (make any Paperclip REST call) and finish (end the heartbeat).
- Tool calling requires a model that supports it (gemma4, llama3.1, mistral-nemo, qwen2.5-coder, etc.).
- If Ollama is unreachable, the heartbeat fails with an error (no silent fallback).

Notes:
- gemma4:latest is Google's Gemma 4 model and supports function calling well.
- Use \`ollama list\` on the Ollama host to see available models.
- Keep maxTurns low (5-10) for simple triage agents; higher for autonomous workers.
`;
