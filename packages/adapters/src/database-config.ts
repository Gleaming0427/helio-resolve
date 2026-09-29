import "./env.js";

type Environment = Readonly<Record<string, string | undefined>>;

/** Shared by Prisma, pgvector and the Prisma CLI. Never include secrets in errors. */
export function databaseUrl(environment: Environment = process.env): string {
  if (environment.DATABASE_URL) {
    try {
      const url = new URL(environment.DATABASE_URL);
      if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname) {
        throw new Error("Invalid PostgreSQL URL");
      }
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
    }
    // Preserve query parameters (including SSL settings) and escaping as supplied.
    return environment.DATABASE_URL;
  }

  const host = environment.DB_HOST;
  const user = environment.DB_USER;
  const password = environment.DB_PASSWORD;
  const port = environment.DB_PORT ?? "5432";
  const database = environment.DB_NAME ?? "helio";
  const missing = ["DB_HOST", "DB_USER", "DB_PASSWORD"].filter(key => !environment[key]);
  if (missing.length) {
    throw new Error(`Configure DATABASE_URL or provide ${missing.join(", ")}`);
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("DB_PORT must be an integer between 1 and 65535");
  }
  if (!database) throw new Error("DB_NAME must not be empty");
  // Bracket IPv6 addresses; reject URL delimiters in the hostname.
  if (!host || /[\s/@?#]/.test(host)) throw new Error("DB_HOST must be a hostname or IP address");
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const value = `postgresql://${encodeURIComponent(user!)}:${encodeURIComponent(password!)}@${hostname}:${port}/${encodeURIComponent(database)}`;
  try {
    new URL(value);
  } catch {
    throw new Error("DB_HOST must be a valid hostname or IP address");
  }
  return value;
}
