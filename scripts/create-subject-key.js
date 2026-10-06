import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
const filename = resolve(
  process.argv[2] || "deploy/secrets/govbr-subject-key.txt",
);
mkdirSync(dirname(filename), { recursive: true });
writeFileSync(filename, randomBytes(32).toString("hex") + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Chave de proteção criada em arquivo privado. Preserve-a junto com os backups; ela não foi exibida.",
);
