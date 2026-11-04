import { execFile } from 'node:child_process';
import type { ToolDef } from './index.js';

// JARVIS Ops — cockpit deploy tool (DAR-690).
//
// Wraps the scoped local script /usr/local/bin/jarvis-cockpit-deploy.sh so JARVIS can
// pull/build/restart the JARVIS Cockpit (jarvis-command-center, port 8080) conversationally.
// The cockpit runs a production node SSR build (no hot reload by design), so new cockpit
// code needs a rebuild to go live — this tool is that feedback loop.
//
// Unlike intake_deploy (remote MCP box, bearer-authed HTTP), this target is LOCAL: no
// endpoint, no token. All guardrails live in the script (ff-only pull, restart only after a
// successful build, failed build leaves the last-good .output serving). See
// skills/jarvis-ops/cockpit-deploy.md.

const SCRIPT = '/usr/local/bin/jarvis-cockpit-deploy.sh';
const ACTIONS = ['status', 'pull', 'build', 'restart', 'redeploy'] as const;

// The script emits exactly one JSON object on stdout (even on failure, with .ok=false and
// .error set) and may exit non-zero on failure — so capture stdout from both paths and parse.
function runCockpitScript(action: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(SCRIPT, [action], { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (stdout ?? '').trim();
      if (raw) {
        try {
          resolve(JSON.parse(raw));
          return;
        } catch {
          // fall through to error handling with the raw text
        }
      }
      if (err) {
        reject(new Error(`cockpit_deploy: script failed (${err.message})${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      // No parseable JSON but the script "succeeded" — surface the raw output.
      resolve({ ok: false, action, output: raw, error: 'cockpit_deploy: script produced no JSON output' });
    });
  });
}

export const cockpitDeploy: ToolDef = {
  name: 'cockpit_deploy',
  description:
    "Deploy the JARVIS Cockpit (jarvis-command-center, port 8080) on the pi — no SSH needed. " +
    "'status' snapshots the live branch + commit, service state, and HTTP health; 'pull' " +
    "fast-forwards the current branch; 'build' compiles the production SSR build; 'restart' " +
    "restarts the cockpit service; 'redeploy' does pull → build → restart (restart only runs " +
    "after a successful build; a failed build leaves the last-good build serving so the " +
    "dashboard never blanks). Use for 'redeploy the cockpit' / 'ship the cockpit'. Always run " +
    "'status' after a deploy to confirm the commit advanced and HTTP is 200. No auto-retry — " +
    "surface any error to Kevin. See skills/jarvis-ops/cockpit-deploy.md.",
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description: 'Which cockpit deploy operation to run.',
      },
    },
    required: ['action'],
  },
  execute: async (args) => {
    const action = String(args.action);
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      throw new Error(`cockpit_deploy: unknown action '${action}' (expected one of ${ACTIONS.join(', ')})`);
    }
    return runCockpitScript(action);
  },
};
