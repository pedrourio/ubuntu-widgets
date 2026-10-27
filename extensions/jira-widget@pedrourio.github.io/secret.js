// Token do Jira só no chaveiro do usuário (libsecret), nunca em arquivo.
import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('io.github.pedrourio.JiraWidget', Secret.SchemaFlags.NONE, {site: Secret.SchemaAttributeType.STRING});

export const lookupToken = site => new Promise((resolve, reject) =>
    Secret.password_lookup(SCHEMA, {site}, null, (_s, res) => {
        try {
            resolve(Secret.password_lookup_finish(res) || null);
        } catch (e) {
            reject(e);
        }
    }));

export const storeToken = (site, token) => new Promise((resolve, reject) =>
    Secret.password_store(SCHEMA, {site}, Secret.COLLECTION_DEFAULT, 'Jira widget', token, null, (_s, res) => {
        try {
            Secret.password_store_finish(res);
            resolve();
        } catch (e) {
            reject(e);
        }
    }));
