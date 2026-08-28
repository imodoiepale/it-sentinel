import { Service } from "node-windows";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Registers agent-node as a Windows Service running as LocalSystem
 * (node-windows' default when no -u/-p account is specified). Run once via
 * `node dist/service-install.js` from an elevated prompt after
 * install-service.ps1 has staged the files.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const svc = new Service({
  name: "ITSentinelAgent",
  description: "IT Sentinel branch telemetry and elevated-command agent (agent-node).",
  script: join(__dirname, "main.js"),
});

svc.on("install", () => {
  console.log("Service installed, starting...");
  svc.start();
});

svc.install();
