/**
 * Mocha root hooks — start/stop the Grist Docker container once for all test files.
 *
 * Set GRIST_RUNNING=1 to skip container management (server already running).
 */

import { startGrist, stopGrist, waitForGrist } from "./testServer.js";

const externalGrist = process.env.GRIST_RUNNING === "1";

export const mochaHooks = {
  async beforeAll(this: Mocha.Context) {
    this.timeout(120000);

    if (externalGrist) {
      console.log("    Using external Grist instance...");
    } else {
      startGrist();
    }
    await waitForGrist();
  },

  async afterAll() {
    if (!externalGrist) {
      stopGrist();
    }
  },
};
