/**
 * Reading the JSON documents this plugin owns, without being defeated by how
 * they were saved.
 *
 * Every file under the plugin data directory is hand-editable by design — the
 * pin, the ignore list, the proxy table and the aggregate keys are all "open it
 * in an editor and change one id" files. Windows editors (Notepad, PowerShell's
 * `Out-File`, and most IDEs saving as "UTF-8 with BOM") prefix the text with
 * U+FEFF, and `JSON.parse` rejects that prefix outright. The old readers caught
 * the throw and returned "nothing configured", so a byte-order mark turned a
 * perfectly good document into silent absence: the pin stopped being applied,
 * the ignore list stopped being honoured, an aggregate key vanished from the
 * card. Nothing logged, nothing failed.
 *
 * The mark is a property of the ENCODING, never of the document, so it is
 * stripped here rather than tolerated by every call site — and it is only the
 * mark: a document that is genuinely malformed must still read as absence.
 *
 * @module dsh-xdpool/json-file
 */

/** U+FEFF, the byte-order mark a UTF-8 file may start with. */
const BOM = '\uFEFF'

/**
 * Drop one leading byte-order mark.
 *
 * Exactly one: two marks in a row is not a BOM any editor writes, it is a
 * document that starts with a stray character, and swallowing it silently would
 * be guessing on the user's behalf.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/**
 * Parse a JSON document that may carry a byte-order mark.
 *
 * Returns the SAME undefined-on-anything shape every reader already relied on:
 * a missing file is handled by the caller (it does the read), while an
 * unparseable document — including one that is nothing but a BOM — is
 * `undefined`. Callers turn that into their own empty value, so the tolerant
 * behaviour is preserved exactly and only the encoding is now forgiven.
 */
export function parseJsonDocument(text: string): unknown {
  const body = stripBom(text).trim()
  if (body === '') return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}
