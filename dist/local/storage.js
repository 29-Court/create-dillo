import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function objectName(key) {
  return createHash("sha256").update(key).digest("hex");
}
const manifestWrites = /* @__PURE__ */ new Map();
async function mutateManifest(path, operation) {
  const previous = manifestWrites.get(path) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve2) => {
    release = resolve2;
  });
  manifestWrites.set(path, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (manifestWrites.get(path) === next) manifestWrites.delete(path);
  }
}
function metadataObject(metadata, body) {
  const { dataFile: _dataFile, ...publicMetadata } = metadata;
  return {
    ...publicMetadata,
    httpEtag: `"${metadata.etag}"`,
    ...body ? { body, bodyUsed: false } : {},
    writeHttpMetadata(headers) {
      const contentType = metadata.httpMetadata.contentType;
      if (contentType) headers.set("content-type", contentType);
      const contentDisposition = metadata.httpMetadata.contentDisposition;
      if (contentDisposition) headers.set("content-disposition", contentDisposition);
    }
  };
}
async function streamToFile(body, pathname) {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  await mkdir(dirname(pathname), { recursive: true });
  let size = 0;
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const web = body instanceof ReadableStream ? body : new Response(body).body;
  if (!web) throw new TypeError("Object storage needs a body.");
  try {
    await pipeline(
      Readable.fromWeb(web),
      meter,
      createWriteStream(temporary, { flags: "wx" })
    );
    await rename(temporary, pathname);
  } catch (error) {
    await unlink(temporary).catch(() => void 0);
    throw error;
  }
  return { size, etag: hash.digest("hex") };
}
class LocalFileStorage {
  constructor(root) {
    this.root = root;
    const resolved = resolve(root);
    this.objects = resolve(resolved, "objects");
    this.uploads = resolve(resolved, "uploads");
  }
  root;
  objects;
  uploads;
  paths(key) {
    const name = objectName(key);
    const directory = resolve(this.objects, name.slice(0, 2));
    return { data: resolve(directory, `${name}.bin`), metadata: resolve(directory, `${name}.json`) };
  }
  async readMetadata(key) {
    try {
      const metadata = JSON.parse(await readFile(this.paths(key).metadata, "utf8"));
      return metadata.key === key ? metadata : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  bodyPath(key, metadata) {
    const paths = this.paths(key);
    if (!metadata.dataFile) return paths.data;
    if (!new RegExp(`^${objectName(key)}\\.bin\\.[0-9a-f-]{36}$`).test(metadata.dataFile)) {
      throw new Error("Invalid local object body version.");
    }
    return resolve(dirname(paths.data), metadata.dataFile);
  }
  async publish(key, data, metadata) {
    const paths = this.paths(key);
    return mutateManifest(paths.metadata, async () => {
      const temporary = `${paths.metadata}.${randomUUID()}.tmp`;
      try {
        const previous = await this.readMetadata(key);
        const previousBody = previous ? this.bodyPath(key, previous) : void 0;
        metadata.dataFile = basename(data);
        const encoded = `${JSON.stringify(metadata)}
`;
        const body = await open(data, "r");
        try {
          await body.sync();
        } finally {
          await body.close();
        }
        const manifest = await open(temporary, "wx");
        try {
          await manifest.writeFile(encoded, "utf8");
          await manifest.sync();
        } finally {
          await manifest.close();
        }
        await rename(temporary, paths.metadata);
        if (previousBody) await unlink(previousBody).catch(() => void 0);
        return metadataObject(metadata);
      } catch (error) {
        await unlink(temporary).catch(() => void 0);
        await unlink(data).catch(() => void 0);
        throw error;
      }
    });
  }
  async openObject(key) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const metadata = await this.readMetadata(key);
      if (!metadata) return null;
      try {
        return { metadata, handle: await open(this.bodyPath(key, metadata), "r") };
      } catch (error) {
        if (!isMissing(error)) throw error;
        const current = await this.readMetadata(key);
        if (!current || current.dataFile === metadata.dataFile) return null;
      }
    }
    throw new Error("Local object changed repeatedly while opening it; retry the read.");
  }
  async put(key, body, options = {}) {
    const paths = this.paths(key);
    const data = `${paths.data}.${randomUUID()}`;
    try {
      const result = await streamToFile(body, data);
      return await this.publish(key, data, {
        key,
        ...result,
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {}
      });
    } catch (error) {
      await unlink(data).catch(() => void 0);
      throw error;
    }
  }
  async head(key) {
    const object = await this.openObject(key);
    if (!object) return null;
    await object.handle.close();
    return metadataObject(object.metadata);
  }
  async get(key) {
    const object = await this.openObject(key);
    if (!object) return null;
    const body = Readable.toWeb(object.handle.createReadStream());
    return metadataObject(object.metadata, body);
  }
  async delete(key) {
    const paths = this.paths(key);
    return mutateManifest(paths.metadata, async () => {
      const metadata = await this.readMetadata(key);
      const data = metadata ? this.bodyPath(key, metadata) : paths.data;
      await unlink(data).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await unlink(paths.metadata).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    });
  }
  async createMultipartUpload(key, options = {}) {
    const uploadId = randomUUID();
    const directory = resolve(this.uploads, uploadId);
    await mkdir(directory, { recursive: true });
    const metadata = {
      key,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {}
    };
    await writeFile(resolve(directory, "upload.json"), `${JSON.stringify(metadata)}
`, "utf8");
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new TypeError("Invalid local multipart upload ID.");
    const directory = resolve(this.uploads, uploadId);
    const load = async () => {
      const metadata = JSON.parse(await readFile(resolve(directory, "upload.json"), "utf8"));
      if (metadata.key !== key) throw new Error("Multipart upload key does not match.");
      return metadata;
    };
    return {
      uploadId,
      uploadPart: async (partNumber, body) => {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 1e4) {
          throw new TypeError("Invalid multipart part number.");
        }
        await load();
        const result = await streamToFile(body, resolve(directory, `${partNumber}.part`));
        await writeFile(
          resolve(directory, `${partNumber}.json`),
          `${JSON.stringify(result)}
`,
          "utf8"
        );
        return { partNumber, etag: result.etag };
      },
      complete: async (parts) => {
        if (!Array.isArray(parts) || parts.length === 0 || parts.length > 1e4 || parts.some((part, index) => !part || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 1e4 || typeof part.etag !== "string" || !part.etag || index > 0 && part.partNumber <= parts[index - 1].partNumber)) {
          throw new TypeError("Multipart parts must have unique, increasing valid part numbers and etags.");
        }
        const upload = await load();
        const paths = this.paths(key);
        const temporary = `${paths.data}.${randomUUID()}`;
        await mkdir(dirname(paths.data), { recursive: true });
        const destination = await open(temporary, "wx");
        const hash = createHash("sha256");
        let size = 0;
        try {
          for (const part of parts) {
            const info = JSON.parse(
              await readFile(resolve(directory, `${part.partNumber}.json`), "utf8")
            );
            if (info.etag !== part.etag) throw new Error(`Multipart part ${part.partNumber} changed.`);
            const partHash = createHash("sha256");
            let partSize = 0;
            for await (const chunk of createReadStream(resolve(directory, `${part.partNumber}.part`))) {
              const bytes = chunk;
              let offset = 0;
              while (offset < bytes.byteLength) {
                const { bytesWritten } = await destination.write(bytes.subarray(offset));
                if (bytesWritten === 0) throw new Error("Local object storage stopped writing a multipart part.");
                offset += bytesWritten;
              }
              hash.update(bytes);
              partHash.update(bytes);
              partSize += bytes.byteLength;
              size += bytes.byteLength;
            }
            if (partSize !== info.size || partHash.digest("hex") !== info.etag) {
              throw new Error(`Multipart part ${part.partNumber} changed or is corrupt.`);
            }
          }
          await destination.sync();
          await destination.close();
          const metadata = {
            key,
            size,
            etag: hash.digest("hex"),
            httpMetadata: upload.httpMetadata,
            customMetadata: upload.customMetadata
          };
          const published = await this.publish(key, temporary, metadata);
          await rm(directory, { recursive: true, force: true }).catch(() => void 0);
          return published;
        } catch (error) {
          await destination.close().catch(() => void 0);
          await unlink(temporary).catch(() => void 0);
          throw error;
        }
      },
      abort: async () => {
        await load();
        await rm(directory, { recursive: true, force: true });
      }
    };
  }
}
export {
  LocalFileStorage
};
