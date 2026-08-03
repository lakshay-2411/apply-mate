/**
 * Consume a newline-delimited-JSON (NDJSON) response body, invoking
 * `onValue` for each parsed line as it arrives. Used by the client to
 * show live progress while the server streams send results.
 */
export async function readNdjsonStream<T>(
  res: Response,
  onValue: (value: T) => void
): Promise<void> {
  if (!res.body) throw new Error("Response has no body to stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onValue(JSON.parse(line) as T);
    }
  }
  if (buffer.trim()) onValue(JSON.parse(buffer) as T);
}
