/**
 * Boot-time env assertions for the worker service (F19): it does NOT inherit
 * the web service's environment, so every process.env read of the reused
 * helpers is audited here and a misprovisioned worker dies at startup with a
 * named missing var, not at first dispatch.
 *
 * Audited reads:
 *   DATABASE_URL          — @/lib/db (Prisma) + pg-boss itself
 *   AGENTGLOB_AGENT_NAME  — @/lib/agentglob (callAgent endpoint)
 *   APP_BASE_URL          — @/lib/agentRuntimeAuth (manifest links; its
 *                           fallback would silently point a misprovisioned
 *                           worker at prod, so it is required here)
 *   AGENTGLOB_APP_API_KEY — @/lib/agentglob (authorization header). WARN-only:
 *                           callAgent sends it conditionally and the dashboard
 *                           is still in its accept→send→require rollout — it is
 *                           empty even in dev today, so requiring it would
 *                           block a worker that dispatches fine without it.
 */
export const REQUIRED_WORKER_ENV = ["DATABASE_URL", "AGENTGLOB_AGENT_NAME", "APP_BASE_URL"] as const;
export const OPTIONAL_WORKER_ENV = ["AGENTGLOB_APP_API_KEY"] as const;

export function assertWorkerEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of REQUIRED_WORKER_ENV) {
    if (!env[name]) {
      throw new Error(`[worker] missing required env var: ${name}`);
    }
  }
  for (const name of OPTIONAL_WORKER_ENV) {
    if (!env[name]) {
      console.warn(`[worker] env var ${name} is empty — callAgent will send unauthenticated`);
    }
  }
}
