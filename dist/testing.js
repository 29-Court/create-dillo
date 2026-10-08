async function checkAdapter({ database, storage }) {
  const id = crypto.randomUUID().replaceAll("-", "");
  const table = `_armadillo_probe_${id}`;
  const key = `armadillo-adapter-check/${id}`;
  const checks = [];
  function expect(condition, message) {
    if (!condition) throw new Error(`Adapter contract failed: ${message}`);
  }
  try {
    await database.prepare(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`).run();
    const value = JSON.stringify({ text: "literal ?1 and 'quotes'", enabled: true });
    await database.prepare(`INSERT INTO ${table} (id, data) VALUES (?2, ?1)`).bind(value, "one").run();
    const row = await database.prepare(`SELECT id, json_extract(data, '$.text') AS text, '?literal' AS literal FROM ${table} WHERE id = ?1 OR id = ?1`).bind("one").first();
    expect(row?.id === "one" && row.text === "literal ?1 and 'quotes'" && row.literal === "?literal", "numbered/repeated parameters, quoted SQL and JSON extraction");
    checks.push("SQL bindings and JSON");
    let rejected = false;
    try {
      await database.batch([
        database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).bind("two", "{}"),
        database.prepare(`INSERT INTO ${table} VALUES (?, ?)`).bind("one", "{}")
      ]);
    } catch {
      rejected = true;
    }
    expect(rejected, "a failed batch must reject");
    expect(await database.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind("two").first() === null, "a failed batch must roll back earlier writes");
    checks.push("Atomic batch rollback");
    const result = await database.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).bind("{}", "one").run();
    expect(result.meta.changes === 1, "mutation change counts");
    expect((await database.prepare(`SELECT id FROM ${table}`).all()).results?.length === 1, "all() results");
    checks.push("Query and mutation results");
    const bytes = new TextEncoder().encode("Armadillo adapter \u2713");
    const uploaded = await storage.put(key, new Blob([bytes]).stream(), { httpMetadata: { contentType: "text/plain" } });
    expect(uploaded?.size === bytes.length && uploaded.etag, "object size and etag");
    const head = await storage.head(key);
    expect(head?.size === bytes.length && head.etag === uploaded.etag, "object metadata");
    const object = await storage.get(key);
    expect(object && await new Response(object.body).text() === "Armadillo adapter \u2713", "streaming object round trip");
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    expect(headers.get("content-type") === "text/plain", "HTTP object metadata");
    checks.push("Object storage round trip");
    const upload = await storage.createMultipartUpload(`${key}/multipart`, { httpMetadata: { contentType: "text/plain" } });
    try {
      const part = await upload.uploadPart(1, new Blob([bytes]).stream());
      const completed = await storage.resumeMultipartUpload(`${key}/multipart`, upload.uploadId).complete([part]);
      expect(completed.size === bytes.length, "multipart completion");
      const multipart = await storage.get(`${key}/multipart`);
      expect(multipart && await new Response(multipart.body).text() === "Armadillo adapter \u2713", "multipart content");
    } catch (error) {
      await upload.abort();
      throw error;
    }
    const aborted = await storage.createMultipartUpload(`${key}/aborted`, { httpMetadata: {} });
    await aborted.abort();
    expect(await storage.head(`${key}/aborted`) === null, "aborted upload is not an object");
    checks.push("Multipart resume, complete and abort");
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.get(key) === null && await storage.head(key) === null, "idempotent deletion and missing objects");
    checks.push("Object deletion");
    return { checks };
  } finally {
    await database.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    await storage.delete(key);
    await storage.delete(`${key}/multipart`);
    await storage.delete(`${key}/aborted`);
  }
}
export {
  checkAdapter
};
