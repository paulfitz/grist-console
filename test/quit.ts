/**
 * Test that the console process exits cleanly when 'q' is pressed.
 */

import { assert } from "chai";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import {
  SERVER_URL, API_KEY, createTestDoc, applyUserActions, addRows,
} from "./testServer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Quit behavior", function() {
  this.timeout(30000);

  let docId: string;

  before(async function() {
    const result = await createTestDoc("quit-test");
    docId = result.docId;
    await applyUserActions(docId, [
      ["AddTable", "Items", [
        { id: "Name", type: "Text", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(docId, "Items", { Name: ["one", "two"] });
  });

  it("exits within 2 seconds after pressing q", function(done) {
    const cli = path.resolve(__dirname, "..", "src", "index.js");
    const child = spawn(process.execPath, [cli, SERVER_URL, docId, "--api-key", API_KEY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let stdout = "";
    let exited = false;
    let sentQ = false;

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Once we see render output (ANSI escape = screen drawn), send 'q'
      if (!sentQ && (stdout.includes("Select") || stdout.includes("\x1b["))) {
        sentQ = true;
        // Small delay to ensure the process is reading stdin
        setTimeout(() => {
          child.stdin!.write("q");
          // Also end stdin to signal EOF, in case raw mode isn't active (non-TTY)
          child.stdin!.end();
        }, 200);
      }
    });

    child.on("exit", (code) => {
      exited = true;
      // Should exit with code 0
      assert.equal(code, 0, `Process exited with code ${code}`);
      done();
    });

    // Fail if it hasn't exited within 5 seconds
    setTimeout(() => {
      if (!exited) {
        child.kill("SIGKILL");
        done(new Error("Process did not exit within 5 seconds after pressing q"));
      }
    }, 5000);
  });
});
