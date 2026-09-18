/**
 * tools/server/storage.mjs — Storage driver factory.
 *
 * The storage interface every driver implements (all async):
 *
 *   init(config)
 *   getRegistration(publicIp)            -> reg | null
 *   listRegistrations()                  -> [reg]
 *   upsertRegistration(reg)              -> reg
 *   deleteRegistration(publicIp)         -> boolean
 *   sweepExpired(now)                    -> number removed
 *   createToken(label)                   -> token string
 *   listTokens()                         -> [{token,label,created_at,revoked}]
 *   revokeToken(token)                   -> boolean
 *   tokenValid(token)                    -> boolean
 *   listUpdates()                        -> [{id,version,url,sha256,platform,created_at}]
 *   getCurrentUpdate(platform?)          -> update | null
 *   publishUpdate(update)                -> id
 *   deleteUpdate(id)                     -> boolean
 *   stats()                              -> {driver,registrations,tokens,updates,admins}
 *   listAdmins()                         -> [{email,uid,added_at}]
 *   getAdminByEmail(email)               -> admin | null
 *   addAdmin({email,uid})                -> admin
 *   removeAdmin(email)                   -> boolean
 *   listCredentials()                    -> [cred]
 *   getCredential(credId)                -> cred | null
 *   addCredential(cred)                  -> cred
 *   deleteCredential(credId)             -> boolean
 *   saveChallenge(id, ch)                -> void
 *   getChallenge(id)                     -> challenge | null
 *   deleteChallenge(id)                  -> boolean
 *   audit({ts,actor,method,detail,ip})   -> void
 *   listAudit(limit?)                    -> [auditEntry]
 *   close()
 *
 * To add a driver: create drivers/<name>.mjs implementing this interface and
 * select it with STORAGE_DRIVER=<name>. Nothing else changes.
 *
 * Drivers are loaded LAZILY (dynamic import) so that local zero-dependency
 * installs never have to install optional deps (e.g. firebase-admin is only
 * needed for STORAGE_DRIVER=firestore).
 */

const DRIVERS = {
	memory: () => import("./drivers/memory.mjs"),
	json: () => import("./drivers/json.mjs"),
	sqlite: () => import("./drivers/sqlite.mjs"),
	firestore: () => import("./drivers/firestore.mjs"),
};

export async function createStorage(config) {
	const loader = DRIVERS[config.STORAGE_DRIVER];
	if (!loader) {
		throw new Error(
			`Unknown STORAGE_DRIVER "${config.STORAGE_DRIVER}". ` +
				`Available: ${Object.keys(DRIVERS).join(", ")}`,
		);
	}
	const driver = await loader();
	await driver.init(config);
	console.log(`[storage] Driver: ${driver.name}`);
	return driver;
}
