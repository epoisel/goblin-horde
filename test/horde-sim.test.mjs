import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SIM = fileURLToPath(new URL("../scripts/sim/horde-sim.mjs", import.meta.url));
const simulate = (...args) => JSON.parse(execFileSync(process.execPath, [SIM, "--json", ...args], { encoding: "utf8" }));

test("the simulator replays the same run for the same seed and a different one for another seed", () => {
  const run = simulate("--persona", "typical", "--days", "30", "--seed", "7");
  assert.equal(run.personas.typical.days.length, 30);
  assert.deepEqual(simulate("--persona", "typical", "--days", "30", "--seed", "7"), run);
  assert.notDeepEqual(simulate("--persona", "typical", "--days", "30", "--seed", "8").personas.typical.days, run.personas.typical.days);
});

test("every stream of work pays: a fleet with nine times a heavy user's turns earns far more coins a day, and the report says how many", () => {
  const { personas } = simulate("--persona", "all", "--days", "30");
  const perDay = (name) => personas[name].metrics.coinsPerDayDay30;
  assert.ok(perDay("fleet") >= 6 * perDay("heavy"), `fleet ${perDay("fleet")} coins a day against heavy ${perDay("heavy")}`);
  assert.ok(perDay("heavy") > perDay("typical") && perDay("typical") > perDay("light"));
  assert.equal(personas.fleet.metrics.coinsPerDayDay60, null, "a 30-day run is too short for day 60");
  const report = execFileSync(process.execPath, [SIM, "--persona", "fleet", "--days", "30"], { encoding: "utf8" });
  assert.match(report, /coinsPerDayDay7 +\d/);
  assert.match(report, /coinsPerDayDay30 +\d/);
});

test("no simulated player ever shows a negative wallet or loses a cleared boss", () => {
  const { personas } = simulate("--persona", "all", "--days", "60");
  assert.deepEqual(Object.keys(personas).sort(), ["farmer", "fleet", "heavy", "light", "typical"]);
  for (const [name, { days }] of Object.entries(personas)) {
    assert.equal(days.length, 60, name);
    days.forEach((day, i) => {
      assert.ok(day.wallet.coins >= 0 && day.wallet.scrap >= 0 && day.horde.xp >= 0, `${name} day ${day.day} has ${JSON.stringify(day.wallet)}`);
      if (i) assert.ok(day.bosses.cleared >= days[i - 1].bosses.cleared, `${name} lost a boss on day ${day.day}`);
    });
    assert.ok(days.at(-1).bosses.cleared > 0, `${name} cleared a boss`);
  }
});
