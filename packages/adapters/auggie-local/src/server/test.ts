import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { parseAuggieOutput } from "./parse.js";
import { discoverAuggieModels } from "./models.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

const AUGGIE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+run\s+auggie\s+login|unauthorized|auth(?:entication)?\s+required|session\s+expired|invalid\s+session)/i;

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "auggie");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "auggie_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "auggie_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const cwdInvalid = checks.some((c) => c.code === "auggie_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "auggie_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({
        code: "auggie_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "auggie_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
        hint: "Install auggie with: npm install -g @augment-code/auggie  (or check the Augment docs)",
      });
    }
  }

  const canRunProbe = checks.every(
    (c) => c.code !== "auggie_cwd_invalid" && c.code !== "auggie_command_unresolvable",
  );

  if (canRunProbe) {
    // Try to discover available models
    try {
      const models = await discoverAuggieModels({ command, cwd, env: runtimeEnv });
      if (models.length > 0) {
        checks.push({
          code: "auggie_models_discovered",
          level: "info",
          message: `Discovered ${models.length} model(s) from auggie.`,
        });
      } else {
        checks.push({
          code: "auggie_models_empty",
          level: "warn",
          message: "auggie returned no models.",
          hint: "Run `auggie model list` to verify your session is active.",
        });
      }
    } catch (err) {
      checks.push({
        code: "auggie_models_discovery_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "auggie model discovery failed.",
        hint: "Run `auggie model list` manually to verify authentication.",
      });
    }

    // Run a lightweight hello probe using --print mode
    const configuredModel = asString(config.model, "").trim();
    const maxTurns = asNumber(config.maxTurns, 0);
    const probeArgs = [
      "--print",
      "--output-format", "json",
      "--instruction", "Respond with hello.",
      "--workspace-root", cwd,
    ];
    if (configuredModel) probeArgs.push("--model", configuredModel);
    if (maxTurns > 0) probeArgs.push("--max-turns", "1");
    else probeArgs.push("--max-turns", "1");

    try {
      const probe = await runChildProcess(
        `auggie-envtest-${Date.now()}`,
        command,
        probeArgs,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parseAuggieOutput(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "auggie_hello_probe_timed_out",
          level: "warn",
          message: "auggie hello probe timed out.",
          hint: "Retry the probe. If this persists, run auggie manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && !parsed.errorMessage) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "auggie_hello_probe_passed" : "auggie_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "auggie hello probe succeeded."
            : "auggie probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : { hint: "Run `auggie --print --output-format json --instruction 'Respond with hello.' --workspace-root .` to debug." }),
        });
      } else if (AUGGIE_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "auggie_hello_probe_auth_required",
          level: "warn",
          message: "auggie is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `auggie login` to authenticate, then retry the probe.",
        });
      } else {
        checks.push({
          code: "auggie_hello_probe_failed",
          level: "error",
          message: "auggie hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `auggie --print --output-format json --instruction 'Respond with hello.' --workspace-root .` manually to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "auggie_hello_probe_failed",
        level: "error",
        message: "auggie hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `auggie --print --output-format json --instruction 'Respond with hello.' --workspace-root .` manually to debug.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
