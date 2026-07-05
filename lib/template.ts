/**
 * Tiny placeholder templating. Replaces `{token}` occurrences with values
 * from `vars`. Unknown tokens are left as an empty string.
 *
 * Supported tokens: {company}, {role}, {name}, {email} — plus anything else
 * you pass in.
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ""
  );
}

/** Convert a plain-text body into simple HTML, preserving line breaks. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\r?\n/g, "<br>");
}
