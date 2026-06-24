/** Setup completo do banco: extensão pgvector + tabelas + seed demo (idempotente). */
import "./_env";

import { bootstrap, ensureSchema } from "../src/server/db/bootstrap";
import { closeDb } from "../src/server/db/client";

async function main(): Promise<void> {
  await ensureSchema();
  await bootstrap();
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
