import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { expand } from "dotenv-expand";

expand(config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
}));
