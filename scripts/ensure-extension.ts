/** Cria a extensão pgvector (CREATE EXTENSION IF NOT EXISTS vector). */
import "./_env";

import { closeDb, getSqlClient } from "../src/server/db/client";
import { EXTENSION_SQL } from "../src/server/db/ddl";

async function main(): Promise<void> {
  await getSqlClient().unsafe(EXTENSION_SQL);
  console.log("pgvector extension ready.");
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
