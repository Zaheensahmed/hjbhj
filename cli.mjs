#!/usr/bin/env node
// cli.mjs -- the same report the popup's paste tab shows, on the command line.
//
//   node cli.mjs path/to/jd.txt
//   node cli.mjs path/to/jd.txt --role "AI / LLM security"
//   node cli.mjs path/to/jd.txt --skills 15
//   cat jd.txt | node cli.mjs -
//
// Reads data/profile.json and the file you name. Makes no network requests.
import fs from "node:fs";
import path from "node:path";

import { buildReport, reportToText } from "./engine/report.js";

const root = import.meta.dirname;
const argv = process.argv.slice(2);

// data/profile.json holds real personal data and is gitignored. A clean clone
// has only the example, which is structurally identical with placeholder
// values, so this still runs rather than crashing on a missing file.
function profilePath() {
  const real = path.join(root, "data/profile.json");
  return fs.existsSync(real) ? real : path.join(root, "data/profile.example.json");
}

if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
  console.log(`usage: node cli.mjs <path-to-jd.txt | -> [--role "<role type>"] [--skills <n>]

Role types, exactly as assembly_rules.role_type_tags names them:
${Object.keys(JSON.parse(fs.readFileSync(profilePath(), "utf8")).assembly_rules.role_type_tags)
  .map((r) => "  " + r).join("\n")}`);
  process.exit(argv.length ? 0 : 1);
}

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

const source = argv[0];
let jd;
try {
  jd = source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
} catch (err) {
  console.error(`Could not read ${source === "-" ? "stdin" : source}: ${err.message}`);
  process.exit(1);
}

const chosenProfile = profilePath();
const profile = JSON.parse(fs.readFileSync(chosenProfile, "utf8"));
if (chosenProfile.endsWith("profile.example.json")) {
  console.error("note: using data/profile.example.json. Copy it to data/profile.json and put your own details in.\n");
}
const roleTypeOverride = flag("--role");

if (roleTypeOverride && !(roleTypeOverride in profile.assembly_rules.role_type_tags)) {
  console.error(`Unknown role type: "${roleTypeOverride}". Run with --help for the list.`);
  process.exit(1);
}

const report = buildReport(profile, jd, {
  roleTypeOverride,
  skillLimit: flag("--skills") ? Number(flag("--skills")) : 10
});

process.stdout.write(reportToText(report, profile));

// A hard blocker or a refused output is worth a non-zero exit so this composes
// in a shell pipeline.
const refused = report.assembled.violations && report.assembled.violations.length > 0;
process.exit(report.eligibility.blocked || refused ? 2 : 0);
