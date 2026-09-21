// One-time local setup: env file, browser for PDF rendering and applying, database.
import { execSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

if (!fs.existsSync(".env")) {
  fs.copyFileSync(".env.example", ".env");
  console.log("Created .env from .env.example. Add your AI provider credentials there.");
}
run("pnpm --filter @prowl/documents exec playwright install chromium");
run("pnpm db:migrate");
console.log("\nSetup complete. Start everything with: pnpm dev  (then open http://localhost:3000)");
