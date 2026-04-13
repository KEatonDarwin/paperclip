import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { config } = ctx;

  const baseUrl = asString(config.baseUrl, "").replace(/\/$/, "");
  const model = asString(config.model, "");

  const checks: AdapterEnvironmentTestResult["checks"] = [];

  if (!baseUrl) {
    checks.push({
      code: "ollama_base_url_missing",
      level: "error",
      message: "baseUrl is required",
      hint: "Set baseUrl to your Ollama server URL, e.g. http://192.168.1.21:11434",
    });
    return { adapterType: "ollama_local", status: "fail", checks, testedAt: new Date().toISOString() };
  }

  if (!model) {
    checks.push({
      code: "ollama_model_missing",
      level: "error",
      message: "model is required",
      hint: "Set model to an Ollama model name, e.g. gemma4:latest",
    });
  }

  // Test connectivity to Ollama
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let reachable = false;
    let availableModels: string[] = [];

    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      if (res.ok) {
        reachable = true;
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        availableModels = (data.models ?? []).map((m) => m.name);
      }
    } finally {
      clearTimeout(timer);
    }

    if (reachable) {
      checks.push({
        code: "ollama_reachable",
        level: "info",
        message: `Ollama is reachable at ${baseUrl}`,
        detail: `${availableModels.length} model(s) available: ${availableModels.slice(0, 5).join(", ")}${availableModels.length > 5 ? "..." : ""}`,
      });

      if (model && availableModels.length > 0) {
        const modelAvailable = availableModels.some(
          (m) => m === model || m.startsWith(model.split(":")[0]),
        );
        if (modelAvailable) {
          checks.push({
            code: "ollama_model_available",
            level: "info",
            message: `Model "${model}" is available`,
          });
        } else {
          checks.push({
            code: "ollama_model_not_found",
            level: "warn",
            message: `Model "${model}" not found in Ollama`,
            hint: `Available models: ${availableModels.slice(0, 5).join(", ")}. Run \`ollama pull ${model}\` on the Ollama host.`,
          });
        }
      }
    } else {
      checks.push({
        code: "ollama_unreachable",
        level: "error",
        message: `Cannot reach Ollama at ${baseUrl}`,
        hint: "Ensure Ollama is running and the baseUrl is correct",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_connection_error",
      level: "error",
      message: `Connection error: ${msg}`,
      hint: "Check that Ollama is running and accessible from this machine",
    });
  }

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: "ollama_local",
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
