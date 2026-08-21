#!/usr/bin/env node

import { runCli } from "./cli.js";
import { GetuiClient } from "./client.js";
import { OperationExecutor } from "./executor.js";
import { renderDiagnostics } from "./output.js";
import { ProfileService } from "./profile.js";

const profileService = new ProfileService();
const client = new GetuiClient({ profileService });
const executor = new OperationExecutor({
  profileService,
  client,
  onDiagnostics(events) {
    const rendered = renderDiagnostics(events);
    if (rendered.length > 0) {
      process.stderr.write(`${rendered}\n`);
    }
  },
});

process.exitCode = await runCli(process.argv.slice(2), {
  profileService,
  executor,
});
