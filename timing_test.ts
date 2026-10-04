import { assertTimingInvariants, routerAttemptTimeoutMs } from "./timing.ts";

function assertEqual(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

Deno.test("default timing overrides preserve all budget invariants", () => {
  const violations = assertTimingInvariants();
  if (violations.length) throw new Error(violations.join("\n"));
});

Deno.test("a 14-second route leaves room for three provider fallbacks", () => {
  // routeInference reserves 500ms for its final error/response, leaving 13.5s for attempts.
  assertEqual(routerAttemptTimeoutMs(13_500, 7), 4_500, "first provider slice");
  assertEqual(routerAttemptTimeoutMs(9_000, 6), 4_500, "second provider slice");
  assertEqual(routerAttemptTimeoutMs(4_500, 5), 4_500, "third provider slice");
});

Deno.test("short deadlines only start attempts that meet the minimum useful window", () => {
  assertEqual(routerAttemptTimeoutMs(8_000, 7), 4_000, "two attempts fit");
  assertEqual(routerAttemptTimeoutMs(3_999, 7), 0, "less than one minimum attempt");
  assertEqual(routerAttemptTimeoutMs(13_500, 1), 13_500, "single remaining provider");
});
