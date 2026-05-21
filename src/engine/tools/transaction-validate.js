/**
 * Engine-side validation for create_transaction / update_transaction.
 *
 * The LLM provider already filters obvious mistakes against the JSON schema
 * we ship with the tool definition (required keys present, correct types).
 * This validator adds a second layer that the engine controls directly:
 *
 *   - Required fields must carry a meaningful value, not just be present.
 *     Empty strings, null, and empty arrays/objects are rejected.
 *   - For `object_list` fields, every item is checked against the declared
 *     `## Item Fields` shape — each item's required sub-fields must exist
 *     and carry a value.
 *
 * Why a second layer:
 *   - Providers only check key presence, not value substance. `table: ""`
 *     passes provider validation but isn't useful.
 *   - update_transaction's tool schema doesn't constrain the custom field
 *     shape at all, so updates currently bypass schema checks entirely.
 *   - A new/lax provider could drop schema enforcement; engine-side checks
 *     keep behavior consistent across providers.
 *
 * Errors are returned as `{ ok: false, error: "..." }` so the caller can
 * surface them as a tool result. The LLM treats that the same as any other
 * tool error — it reads the message and retries.
 *
 * Workspaces with no `## Transaction Fields` block see a no-op: the
 * validator returns `{ ok: true }` without inspecting args.
 */

/**
 * Check that `value` carries something meaningful for a field of type `type`.
 * Returns true when the value is missing or empty.
 *
 * Booleans and the number `0` are NOT considered empty — those are valid
 * values that just happen to be falsy.
 */
function isEmptyValue(value, type) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (type === 'object_list' && typeof value === 'object') {
    return Object.keys(value).length === 0;
  }
  return false;
}

/**
 * Validate one item inside an object_list field against the parsed
 * `## Item Fields` block. Returns null on success or an error string.
 */
function validateItem(item, parsedItemFields, fieldKey, index) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return `${fieldKey}[${index}] must be an object.`;
  }
  if (!parsedItemFields || !parsedItemFields.fields || parsedItemFields.fields.length === 0) {
    return null;
  }
  for (const f of parsedItemFields.fields) {
    if (!f.isRequired) continue;
    if (isEmptyValue(item[f.key], f.type)) {
      return `${fieldKey}[${index}].${f.key} is required and must not be empty.`;
    }
  }
  return null;
}

/**
 * Validate a payload against the parsed transaction-fields schema.
 *
 * @param {object} args - The tool arguments (the LLM's call payload).
 * @param {object} parsedFields - Output of parseTransactionFieldsBlock.
 * @param {object} parsedItemFields - Output of parseItemFieldsBlock.
 * @param {object} opts
 * @param {'create'|'update'} opts.mode - 'update' only validates fields the
 *   caller is actually changing — unchanged required fields are not
 *   re-required because the existing row already has them.
 * @param {{default: string, allowed: string[]} | null} opts.currencyDecl -
 *   Parsed `Currency:` declaration from SKILL.md. When provided, an agent
 *   passing a `currency` value must use one from `allowed`. When omitted,
 *   currency is unrestricted (legacy behavior).
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateTransactionPayload(args, parsedFields, parsedItemFields, opts = {}) {
  const mode = opts.mode || 'create';
  const payload = args || {};

  // For updates, custom fields can arrive at the top level OR inside
  // `updates`. Merge with top-level winning (matches updateTransaction's
  // own precedence).
  const effective = mode === 'update'
    ? { ...(payload.updates || {}), ...payload }
    : payload;

  // Field-level checks (required, item shape) — only when fields are
  // declared. The currency check below is independent.
  if (parsedFields && parsedFields.fields && parsedFields.fields.length > 0) {
    for (const f of parsedFields.fields) {
      const value = effective[f.key];
      const provided = Object.prototype.hasOwnProperty.call(effective, f.key);

      // On update, only validate fields the caller is touching. Unchanged
      // required fields are already populated on the stored row.
      if (mode === 'update' && !provided) continue;

      if (f.isRequired && isEmptyValue(value, f.type)) {
        return { ok: false, error: `${f.key} is required and must not be empty.` };
      }

      // Item-shape check: if this field is declared object_list and a value
      // was provided, every item must satisfy the Item Fields schema.
      if (f.type === 'object_list' && provided && !isEmptyValue(value, f.type)) {
        if (!Array.isArray(value)) {
          return { ok: false, error: `${f.key} must be a list of items.` };
        }
        for (let i = 0; i < value.length; i++) {
          const err = validateItem(value[i], parsedItemFields, f.key, i);
          if (err) return { ok: false, error: err };
        }
      }
    }
  }

  // Currency check — only enforced when SKILL.md declares one. `currency`
  // is a top-level transaction field (not part of `## Transaction Fields`),
  // so its check lives outside the loop above.
  const decl = opts.currencyDecl;
  if (decl && Array.isArray(decl.allowed) && decl.allowed.length > 0) {
    const provided = Object.prototype.hasOwnProperty.call(effective, 'currency');
    const value = effective.currency;
    // Skip if not provided or empty — caller will fill in decl.default.
    if (provided && !isEmptyValue(value, 'text')) {
      const normalized = String(value).trim().toUpperCase();
      const match = decl.allowed.some(c => c.toUpperCase() === normalized);
      if (!match) {
        const list = decl.allowed.join(', ');
        const hint = decl.allowed.length === 1
          ? `currency must be ${decl.allowed[0]}. Pass ${decl.allowed[0]} or omit the field.`
          : `currency must be one of ${list}. Pass one of those or omit to use ${decl.default}.`;
        return { ok: false, error: hint };
      }
    }
  }

  return { ok: true };
}
