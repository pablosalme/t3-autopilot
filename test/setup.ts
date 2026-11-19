import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test file starts with a temporary data directory, so no test reads or
// writes ~/.t3-autopilot (policy, log, capabilities cache, unavailable marks),
// even through a server created with the default paths.
process.env.T3_AUTOPILOT_HOME = mkdtempSync(join(tmpdir(), "t3-autopilot-test-home-"));
