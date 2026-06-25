/**
 * Unit tests for ask_oracle's classifier — pure parser + prefilter only.
 * Run after `npm run build` (imports the compiled module). No network.
 */
import {
  parseClassification,
  prefilter,
  ClassifierError,
} from "../build/oracleClassifier.js";

let passed = 0,
  failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}
function throws(fn, label) {
  try {
    fn();
    failed++;
    console.log(`  ✗ ${label} (did not throw)`);
  } catch (e) {
    ok(e instanceof ClassifierError, `${label} (ClassifierError)`);
  }
}

const valid = JSON.stringify({
  difficulty: "moderate",
  domains: ["econ", "policy"],
  needs_x: false,
  needs_grounding: true,
  suggested_lens: "georgist",
  suggested_panel_n: 2,
  reasoning_effort: "high",
  rationale: "contested land-value question benefits from grounding",
});

console.log("Unit: parseClassification");
{
  const c = parseClassification(valid);
  ok(c.difficulty === "moderate", "difficulty parsed");
  ok(c.domains.length === 2, "domains parsed");
  ok(c.needs_grounding === true && c.needs_x === false, "capability flags coerced to bool");
  ok(c.suggested_lens === "georgist", "known lens kept");
  ok(c.suggested_panel_n === 2, "panel_n kept");
}
{
  const c = parseClassification("```json\n" + valid + "\n```");
  ok(c.difficulty === "moderate", "code fences stripped");
}
{
  const c = parseClassification(
    JSON.stringify({
      difficulty: "hard",
      domains: "not-an-array",
      needs_x: 1,
      needs_grounding: 0,
      suggested_lens: "made-up-frame",
      suggested_panel_n: 99,
      reasoning_effort: "high",
      rationale: 42,
    }),
  );
  ok(Array.isArray(c.domains) && c.domains.length === 0, "non-array domains => []");
  ok(c.needs_x === true && c.needs_grounding === false, "truthy/falsy flags coerced");
  ok(c.suggested_lens === "default", "unknown lens => default (non-fatal)");
  ok(c.suggested_panel_n === 4, "panel_n clamped to 4");
  ok(c.rationale === "", "non-string rationale => empty");
}
throws(() => parseClassification("not json at all"), "non-JSON throws");
throws(() => parseClassification("[1,2,3]"), "non-object JSON throws");
throws(
  () => parseClassification(JSON.stringify({ ...JSON.parse(valid), difficulty: "epic" })),
  "bad difficulty enum throws",
);
throws(
  () => parseClassification(JSON.stringify({ ...JSON.parse(valid), reasoning_effort: "max" })),
  "bad effort enum throws",
);

console.log("\nUnit: prefilter seeds");
{
  ok(prefilter("what are people tweeting right now").needs_x === true, "x seed fires");
  ok(prefilter("explain monads").needs_x === false, "x seed quiet on neutral prompt");
  ok(prefilter("what is the current price of copper").needs_grounding === true, "grounding seed fires");
  ok(prefilter("write a haiku").needs_grounding === false, "grounding seed quiet on neutral prompt");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
