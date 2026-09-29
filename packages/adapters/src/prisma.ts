import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { databaseUrl } from "./database-config.js";

const adapter = new PrismaPg({
  connectionString: databaseUrl(),
});
export const prisma = new PrismaClient({ adapter });
