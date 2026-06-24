/** Semeia o tenant default + agente demo (idempotente). Não recria o schema. */
import "./_env";

import { bootstrap } from "../src/server/db/bootstrap";
import { closeDb } from "../src/server/db/client";

async function main(): Promise<void> {
  await bootstrap();
  await closeDb();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
