/**
 * Plan test 9 (F4 + F19): `pnpm worker` boots under tsx and dies loudly —
 * naming the var — when a required env var is missing. The spawn half runs the
 * real entrypoint; the unit half pins the exact name reported for each var.
 * (Full smoke in the built deployment image is a deploy gate — plan §2.)
 */
import { it, expect, describe } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

import { assertWorkerEnv, REQUIRED_WORKER_ENV } from "./env";

describe("assertWorkerEnv", () => {
  const full = Object.fromEntries(REQUIRED_WORKER_ENV.map((k) => [k, "x"]));

  it("passes with every required var present", () => {
    expect(() => assertWorkerEnv(full)).not.toThrow();
  });

  for (const name of REQUIRED_WORKER_ENV) {
    it(`dies naming ${name} when it is missing or empty`, () => {
      expect(() => assertWorkerEnv({ ...full, [name]: "" })).toThrow(
        `missing required env var: ${name}`,
      );
    });
  }
});

it("the worker entrypoint exits non-zero and names the missing var (spawned under tsx)", async () => {
  // Minimal env: PATH only. @prisma/client auto-loads .env in dev, which can
  // supply DATABASE_URL/AGENTGLOB_AGENT_NAME locally — but APP_BASE_URL is
  // never in .env (the web app uses its fallback), so at least one required
  // var is missing in every environment this test runs in.
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
    execFile(
      "node_modules/.bin/tsx",
      ["src/worker/index.ts"],
      { cwd: PROJECT_ROOT, env: { PATH: process.env.PATH }, timeout: 25_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : err ? 1 : 0;
        resolve({ code, output: `${stdout}\n${stderr}` });
      },
    );
  });
  expect(code).not.toBe(0);
  expect(output).toMatch(/missing required env var: [A-Z_]+/);
}, 30_000);
