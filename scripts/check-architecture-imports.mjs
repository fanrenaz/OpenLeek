import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contexts = ["experiment", "agent-execution", "social-environment", "financial-market"];
const contractLayers = {
  core: [],
  context: ["core"],
  agent: ["core"],
  "turn-prompt": ["core"],
  world: ["core", "agent"],
  experiment: ["core", "context", "agent", "turn-prompt", "world"],
};

const contractImportRoots = ["apps", "packages", "scripts"].flatMap((directory) => files(join(root, directory)));
for (const file of contractImportRoots.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.includes("/node_modules/") && !file.includes("/.next/"))) {
  const source = readFileSync(file, "utf8");
  if (/from\s+["']@openleek\/contracts["']/.test(source)) {
    fail(`${relative(root, file)} imports the removed @openleek/contracts root entry`);
  }
}

const contractPackage = JSON.parse(readFileSync(join(root, "packages/contracts/package.json"), "utf8"));
if (contractPackage.exports?.["."]) fail("@openleek/contracts must not expose a root entry");

for (const [layer, allowed] of Object.entries(contractLayers)) {
  const file = join(root, "packages", "contracts", "src", `${layer}.ts`);
  const source = readFileSync(file, "utf8");
  for (const dependency of Object.keys(contractLayers)) {
    if (dependency !== layer && source.includes(`from "./${dependency}"`) && !allowed.includes(dependency)) {
      fail(`packages/contracts/src/${layer}.ts has a forbidden dependency on ${dependency}`);
    }
  }
}

for (const owner of contexts) {
  const domain = join(root, "apps", owner, "src", "domain");
  for (const file of files(domain)) {
    const source = readFileSync(file, "utf8");
    for (const foreign of contexts.filter((context) => context !== owner)) {
      if (source.includes(`/apps/${foreign}/`) || source.includes(`@openleek/${foreign}`)) {
        fail(`${relative(root, file)} imports the ${foreign} Context from ${owner} domain`);
      }
    }
    if (/from\s+["'][^"']*(?:interfaces|infrastructure|server)[^"']*["']/.test(source)) {
      fail(`${relative(root, file)} lets ${owner} domain depend on an outer layer`);
    }
  }
}

const consolePackage = JSON.parse(readFileSync(join(root, "apps/console/package.json"), "utf8"));
if (consolePackage.dependencies?.pg || consolePackage.dependencies?.["@types/pg"]) {
  fail("Console may not have a PostgreSQL dependency");
}
console.log("Context domain and Console database-import guards passed");

function files(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory() && [".next", "node_modules", "coverage"].includes(entry.name)) return [];
      return entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)];
    });
  }
  catch { return []; }
}
function fail(message) { console.error(message); process.exit(1); }
