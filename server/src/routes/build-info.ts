import { Router } from "express";
import { execSync } from "node:child_process";
import { serverVersion } from "../version.js";

const serverStartedAt = new Date().toISOString();

function getGitInfo(): {
  commitHash: string;
  commitShortHash: string;
  commitMessage: string;
  commitAuthor: string;
  commitDate: string;
  branch: string;
} | null {
  try {
    const format = "%H%n%h%n%s%n%an%n%aI";
    const log = execSync(`git log -1 --format="${format}"`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const [commitHash, commitShortHash, commitMessage, commitAuthor, commitDate] = log.split("\n");

    let branch = "unknown";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      // ignore
    }

    return {
      commitHash: commitHash ?? "unknown",
      commitShortHash: commitShortHash ?? "unknown",
      commitMessage: commitMessage ?? "unknown",
      commitAuthor: commitAuthor ?? "unknown",
      commitDate: commitDate ?? "unknown",
      branch,
    };
  } catch {
    return null;
  }
}

const cachedGitInfo = getGitInfo();

export function buildInfoRoutes() {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      serverVersion,
      serverStartedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      git: cachedGitInfo,
    });
  });

  return router;
}
