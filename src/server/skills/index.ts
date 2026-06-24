/**
 * Importar este módulo popula o REGISTRY (cada submódulo registra suas skills no
 * import). A ordem espelha `app/skills/__init__.py` (catalog, knowledge, support).
 * Os consumidores usam a API re-exportada daqui.
 */

import "./catalog";
import "./knowledge";
import "./support";

export * from "./base";
