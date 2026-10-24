export type DelegateMode = "write" | "read-only";

export const REVIEW_AGENT = "opencode-delegate-review";
const READ_ACTIONS = ["read", "glob", "grep"];

/** Inline configuration is applied last by OpenCode V2; never mutate project configuration. */
export function reviewEnvironment(env = process.env): NodeJS.ProcessEnv {
  const original = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
  }
  const policies = [
    { action: "tool.use", resource: "*", effect: "deny" },
    ...READ_ACTIONS.map((action) => ({ action: "tool.use", resource: `${action}:*`, effect: "allow" })),
    // Preserve earlier inline restrictions, such as read:secrets/*.
    ...(original.policies ?? []),
  ];
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...original,
      policies,
      agents: {
        ...original.agents,
        [REVIEW_AGENT]: {
          mode: "primary",
          system: "Review and explain the requested code. Use only read, glob and grep. Do not modify files or run commands.",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...READ_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" })),
          ],
        },
      },
    }),
  };
}
