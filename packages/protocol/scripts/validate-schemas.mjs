import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const ajv = new Ajv2020({ allErrors: true });

const schemas = [
  "command.schema.json",
  "plugin-manifest.schema.json",
  "project-manifest.schema.json"
];

for (const schemaName of schemas) {
  const schema = JSON.parse(readFileSync(resolve(root, "schemas", schemaName), "utf8"));
  ajv.compile(schema);
}

console.log(`Validated ${schemas.length} JSON schemas.`);
