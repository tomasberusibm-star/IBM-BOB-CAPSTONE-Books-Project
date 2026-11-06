import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api/openapi.yaml');
export const spec = parse(readFileSync(specPath, 'utf8'));

// OpenAPI 3.0 schemas are close to JSON Schema: Ajv understands `nullable`, we only have to
// teach it the OpenAPI-specific formats and ignore documentation keywords such as `example`.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat('int32', { type: 'number', validate: (n) => Number.isInteger(n) && Math.abs(n) <= 2_147_483_647 });
ajv.addFormat('int64', { type: 'number', validate: (n) => Number.isSafeInteger(n) });
ajv.addFormat('password', () => true);

const resolve = (node) => (node?.$ref ? node.$ref.replace('#/', '').split('/').reduce((o, k) => o[k], spec) : node);
const validators = new Map();

function validatorFor(method, apiPath, status) {
  const key = `${method} ${apiPath} ${status}`;
  if (!validators.has(key)) {
    const operation = spec.paths[apiPath]?.[method.toLowerCase()];
    if (!operation) throw new Error(`Operation not in the OpenAPI spec: ${method} ${apiPath}`);
    const response = resolve(operation.responses[status]);
    const schema = response?.content?.['application/json']?.schema;
    // Wrapping keeps "#/components/..." references resolvable against the whole document.
    validators.set(key, schema ? ajv.compile({ allOf: [schema], components: spec.components }) : null);
  }
  return validators.get(key);
}

/** Status codes the spec documents for an operation (as numbers). */
export function documentedStatuses(method, apiPath) {
  const operation = spec.paths[apiPath]?.[method.toLowerCase()];
  return operation ? Object.keys(operation.responses).map(Number) : [];
}

/**
 * Contract check for a Supertest response: the status must be documented for the operation and
 * the JSON body must satisfy the documented schema (required fields, types, enums, formats).
 *
 * @param {import('supertest').Response} res
 * @param {string} method HTTP verb
 * @param {string} apiPath path template exactly as written in api/openapi.yaml, e.g. '/api/products/{id}'
 * @returns {import('supertest').Response} the same response, for chaining
 */
export function expectContract(res, method, apiPath) {
  const allowed = documentedStatuses(method, apiPath);
  if (!allowed.includes(res.status)) {
    throw new Error(`${method} ${apiPath} returned ${res.status}, which the spec does not document (${allowed.join(', ')}). Body: ${JSON.stringify(res.body)}`);
  }
  const validate = validatorFor(method, apiPath, res.status);
  if (validate && !validate(res.body)) {
    const problems = validate.errors.slice(0, 5).map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; ');
    throw new Error(`${method} ${apiPath} ${res.status} body violates the spec: ${problems}`);
  }
  return res;
}
