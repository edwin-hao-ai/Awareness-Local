/**
 * sync-handshake.mjs — Schema version handshake with cloud.
 *
 * Called on daemon startup before any push/pull.  If the cloud reports an
 * incompatible schema version, sync should be disabled with a clear warning
 * so the user knows to upgrade.
 *
 * Uses only Node.js built-in modules — zero external dependencies.
 * Network errors are treated as "offline — assume compatible" to avoid
 * blocking the daemon when the cloud is unreachable.
 */
// @ts-nocheck


const LOG_PREFIX = '[SyncHandshake]';

/**
 * The schema version this local daemon understands.
 * Increment when the local sync protocol changes in a backward-incompatible
 * way (e.g. new required fields on push, changed pull format).
 */
export const CURRENT_LOCAL_SCHEMA_VERSION = 2;

/**
 * Perform a schema-version handshake with the cloud.
 *
 * Calls `GET {apiBase}/sync/handshake?client_schema={version}` and returns
 * a compatibility assessment.  The cloud is expected to respond with:
 *
 *   { compatible: boolean, cloud_schema_version: number, message?: string }
 *
 * On any network error the function returns a "compatible" result so the
 * daemon can continue operating in offline mode.
 *
 * @param {string} apiBase — Cloud API base URL (e.g. "https://awareness.market/api/v1")
 * @param {string} apiKey  — Bearer token for authentication
 * @param {function} httpGet — async (endpoint) => object|null  — reuse coordinator's _get
 * @returns {Promise<{ compatible: boolean, cloud_schema_version: number|null, message: string }>}
 */
export async function performHandshake(apiBase, apiKey, httpGet) {
  try {
    const endpoint = `/sync/handshake?client_schema=${CURRENT_LOCAL_SCHEMA_VERSION}`;
    const result = await httpGet(endpoint);

    if (!result) {
      // httpGet returns null on non-2xx or network error
      console.log(`${LOG_PREFIX} Handshake endpoint not available — assuming compatible (offline/404)`);
      return {
        compatible: true,
        cloud_schema_version: null,
        message: 'offline — assuming compatible',
      };
    }

    const compatible = result.compatible !== false; // default to true if field missing
    const cloudVersion = result.cloud_schema_version ?? result.schema_version ?? null;
    const message = result.message || '';

    if (!compatible) {
      console.warn(
        `${LOG_PREFIX} INCOMPATIBLE schema — local v${CURRENT_LOCAL_SCHEMA_VERSION}, ` +
          `cloud v${cloudVersion}. ${message}`
      );
    } else {
      console.log(
        `${LOG_PREFIX} Handshake OK — local v${CURRENT_LOCAL_SCHEMA_VERSION}, ` +
          `cloud v${cloudVersion || '?'}`
      );
    }

    return { compatible, cloud_schema_version: cloudVersion, message };
  } catch (err) {
    // Network failures must not block daemon startup
    console.warn(`${LOG_PREFIX} Handshake failed (${err.message}) — assuming compatible`);
    return {
      compatible: true,
      cloud_schema_version: null,
      message: `offline — assuming compatible (${err.message})`,
    };
  }
}
