import { defineConfig } from "drizzle-kit";

// drizzle-kit (push/generate) lê o schema único em src/server/db/schema.ts.
// Em deploy usamos `scripts/setup-db.ts` (extensão pgvector + DDL idempotente +
// seed); `drizzle-kit push` é uma conveniência para dev local.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
