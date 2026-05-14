import { Router } from "express";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { assertCompanyAccess } from "./authz.js";

const execFileAsync = promisify(execFile);

const JARVIS_HEALTH_URL =
  process.env.JARVIS_HEALTH_URL ?? "http://localhost:3200/api/health";
const JARVIS_UI_PORT = process.env.JARVIS_UI_PORT ?? "3201";

interface JarvisStatus {
  up: boolean;
  uptime: string | null;
  activeState: string | null;
  since: string | null;
  pid: number | null;
  memory: string | null;
  healthTime: string | null;
  uiPort: string;
}

async function getSystemdInfo(): Promise<{
  activeState: string | null;
  since: string | null;
  pid: number | null;
  memory: string | null;
}> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "show",
      "jarvis",
      "--property=ActiveState,ActiveEnterTimestamp,MainPID,MemoryCurrent",
    ]);
    const props: Record<string, string> = {};
    for (const line of stdout.trim().split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) props[line.slice(0, idx)] = line.slice(idx + 1);
    }
    const pid = Number(props.MainPID);
    let memBytes = Number(props.MemoryCurrent);
    if (Number.isNaN(memBytes) || memBytes <= 0) {
      if (pid > 0) {
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf-8");
          const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
          if (match) memBytes = Number(match[1]) * 1024;
        } catch {}
      }
    }
    const mem =
      !Number.isNaN(memBytes) && memBytes > 0
        ? `${(memBytes / 1024 / 1024).toFixed(1)} MB`
        : null;
    return {
      activeState: props.ActiveState ?? null,
      since: props.ActiveEnterTimestamp || null,
      pid: pid > 0 ? pid : null,
      memory: mem,
    };
  } catch {
    return { activeState: null, since: null, pid: null, memory: null };
  }
}

async function getHealthCheck(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(JARVIS_HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { time?: string };
    return data.time ?? new Date().toISOString();
  } catch {
    return null;
  }
}

function formatUptime(since: string | null): string | null {
  if (!since) return null;
  const start = new Date(since);
  if (Number.isNaN(start.getTime())) return null;
  const diffMs = Date.now() - start.getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function jarvisStatusRoutes() {
  const router = Router();

  router.get("/companies/:companyId/jarvis/status", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const [systemd, healthTime] = await Promise.all([
      getSystemdInfo(),
      getHealthCheck(),
    ]);
    const up = systemd.activeState === "active" && healthTime !== null;
    const status: JarvisStatus = {
      up,
      uptime: formatUptime(systemd.since),
      activeState: systemd.activeState,
      since: systemd.since,
      pid: systemd.pid,
      memory: systemd.memory,
      healthTime,
      uiPort: JARVIS_UI_PORT,
    };
    res.json(status);
  });

  router.post("/companies/:companyId/jarvis/restart", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    const systemd = await getSystemdInfo();
    if (!systemd.pid || systemd.pid <= 0) {
      res.status(404).json({ error: "JARVIS process not found" });
      return;
    }
    try {
      process.kill(systemd.pid, "SIGTERM");
      res.json({ ok: true, killedPid: systemd.pid });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to kill PID ${systemd.pid}: ${err.message}` });
    }
  });

  return router;
}
