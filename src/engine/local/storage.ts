import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStorage, StoredObject, StoredObjectMetadata, MultipartUpload } from "../engine/ports.js";

interface LocalObjectMetadata {
  key: string;
  size: number;
  etag: string;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  /** Immutable body version; absent in the original filesystem format. */
  dataFile?: string;
}

interface LocalUploadMetadata {
  key: string;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function objectName(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// Serialize manifest changes across storage instances in this process. Readers
// use immutable body handles and do not wait for uploads or replacements.
const manifestWrites = new Map<string, Promise<void>>();
async function mutateManifest<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = manifestWrites.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  manifestWrites.set(path, next);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (manifestWrites.get(path) === next) manifestWrites.delete(path);
  }
}

function metadataObject(metadata: LocalObjectMetadata): StoredObjectMetadata;
function metadataObject(metadata: LocalObjectMetadata, body: ReadableStream): StoredObject;
function metadataObject(metadata: LocalObjectMetadata, body?: ReadableStream): StoredObjectMetadata | StoredObject {
  const { dataFile: _dataFile, ...publicMetadata } = metadata;
  return {
    ...publicMetadata,
    httpEtag: `"${metadata.etag}"`,
    ...(body ? { body, bodyUsed: false } : {}),
    writeHttpMetadata(headers: Headers) {
      const contentType = metadata.httpMetadata.contentType;
      if (contentType) headers.set("content-type", contentType);
      const contentDisposition = metadata.httpMetadata.contentDisposition;
      if (contentDisposition) headers.set("content-disposition", contentDisposition);
    },
  };
}

async function streamToFile(body: unknown, pathname: string): Promise<{ size: number; etag: string }> {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  await mkdir(dirname(pathname), { recursive: true });
  let size = 0;
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const web = body instanceof ReadableStream ? body : new Response(body as BodyInit).body;
  if (!web) throw new TypeError("Object storage needs a body.");
  try {
    await pipeline(
      Readable.fromWeb(web as import("node:stream/web").ReadableStream),
      meter,
      createWriteStream(temporary, { flags: "wx" }),
    );
    await rename(temporary, pathname);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return { size, etag: hash.digest("hex") };
}

/** R2-compatible object facade persisted beneath one local directory. */
export class LocalFileStorage implements ObjectStorage {
  private readonly objects: string;
  private readonly uploads: string;

  constructor(readonly root: string) {
    const resolved = resolve(root);
    this.objects = resolve(resolved, "objects");
    this.uploads = resolve(resolved, "uploads");
  }

  private paths(key: string): { data: string; metadata: string } {
    const name = objectName(key);
    const directory = resolve(this.objects, name.slice(0, 2));
    return { data: resolve(directory, `${name}.bin`), metadata: resolve(directory, `${name}.json`) };
  }

  private async readMetadata(key: string): Promise<LocalObjectMetadata | null> {
    try {
      const metadata = JSON.parse(await readFile(this.paths(key).metadata, "utf8")) as LocalObjectMetadata;
      return metadata.key === key ? metadata : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private bodyPath(key: string, metadata: LocalObjectMetadata): string {
    const paths = this.paths(key);
    if (!metadata.dataFile) return paths.data;
    if (!new RegExp(`^${objectName(key)}\\.bin\\.[0-9a-f-]{36}$`).test(metadata.dataFile)) {
      throw new Error("Invalid local object body version.");
    }
    return resolve(dirname(paths.data), metadata.dataFile);
  }

  private async publish(key: string, data: string, metadata: LocalObjectMetadata): Promise<StoredObjectMetadata> {
    const paths = this.paths(key);
    return mutateManifest(paths.metadata, async () => {
      const temporary = `${paths.metadata}.${randomUUID()}.tmp`;
      try {
        const previous = await this.readMetadata(key);
        const previousBody = previous ? this.bodyPath(key, previous) : undefined;
        metadata.dataFile = basename(data);
        const encoded = `${JSON.stringify(metadata)}\n`;
        const body = await open(data, "r");
        try { await body.sync(); } finally { await body.close(); }
        const manifest = await open(temporary, "wx");
        try { await manifest.writeFile(encoded, "utf8"); await manifest.sync(); }
        finally { await manifest.close(); }
        // This rename is the publication point. The old manifest/body remain
        // intact until the complete new body and metadata have been written.
        await rename(temporary, paths.metadata);
        if (previousBody) await unlink(previousBody).catch(() => undefined);
        return metadataObject(metadata);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        await unlink(data).catch(() => undefined);
        throw error;
      }
    });
  }

  private async openObject(key: string) {
    // A writer may retire the version between reading its manifest and opening
    // the body. Retry the new manifest; an open handle survives rename/delete.
    for (let attempt = 0; attempt < 4; attempt++) {
      const metadata = await this.readMetadata(key);
      if (!metadata) return null;
      try { return { metadata, handle: await open(this.bodyPath(key, metadata), "r") }; }
      catch (error) {
        if (!isMissing(error)) throw error;
        const current = await this.readMetadata(key);
        if (!current || current.dataFile === metadata.dataFile) return null;
      }
    }
    throw new Error("Local object changed repeatedly while opening it; retry the read.");
  }

  async put(
    key: string,
    body: unknown,
    options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {},
  ): Promise<StoredObjectMetadata> {
    const paths = this.paths(key);
    const data = `${paths.data}.${randomUUID()}`;
    try {
      const result = await streamToFile(body, data);
      return await this.publish(key, data, {
        key, ...result,
        httpMetadata: options.httpMetadata ?? {},
        customMetadata: options.customMetadata ?? {},
      });
    } catch (error) {
      await unlink(data).catch(() => undefined);
      throw error;
    }
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    const object = await this.openObject(key);
    if (!object) return null;
    await object.handle.close();
    return metadataObject(object.metadata);
  }

  async get(key: string): Promise<StoredObject | null> {
    const object = await this.openObject(key);
    if (!object) return null;
    const body = Readable.toWeb(object.handle.createReadStream()) as ReadableStream;
    return metadataObject(object.metadata, body);
  }

  async delete(key: string): Promise<void> {
    const paths = this.paths(key);
    return mutateManifest(paths.metadata, async () => {
      const metadata = await this.readMetadata(key);
      const data = metadata ? this.bodyPath(key, metadata) : paths.data;
      // Keep the pointer if body cleanup fails, so a retry can still find it.
      await unlink(data)
        .catch((error: unknown) => { if (!isMissing(error)) throw error; });
      await unlink(paths.metadata).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    });
  }

  async createMultipartUpload(
    key: string,
    options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {},
  ): Promise<MultipartUpload> {
    const uploadId = randomUUID();
    const directory = resolve(this.uploads, uploadId);
    await mkdir(directory, { recursive: true });
    const metadata: LocalUploadMetadata = {
      key,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    await writeFile(resolve(directory, "upload.json"), `${JSON.stringify(metadata)}\n`, "utf8");
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new TypeError("Invalid local multipart upload ID.");
    const directory = resolve(this.uploads, uploadId);
    const load = async (): Promise<LocalUploadMetadata> => {
      const metadata = JSON.parse(await readFile(resolve(directory, "upload.json"), "utf8")) as LocalUploadMetadata;
      if (metadata.key !== key) throw new Error("Multipart upload key does not match.");
      return metadata;
    };
    return {
      uploadId,
      uploadPart: async (partNumber: number, body: unknown) => {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
          throw new TypeError("Invalid multipart part number.");
        }
        await load();
        const result = await streamToFile(body, resolve(directory, `${partNumber}.part`));
        await writeFile(
          resolve(directory, `${partNumber}.json`),
          `${JSON.stringify(result)}\n`,
          "utf8",
        );
        return { partNumber, etag: result.etag };
      },
      complete: async (parts: readonly { partNumber: number; etag: string }[]) => {
        if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10_000 || parts.some((part, index) =>
          !part || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > 10_000
          || typeof part.etag !== "string" || !part.etag
          || (index > 0 && part.partNumber <= parts[index - 1]!.partNumber))) {
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
              await readFile(resolve(directory, `${part.partNumber}.json`), "utf8"),
            ) as { size: number; etag: string };
            if (info.etag !== part.etag) throw new Error(`Multipart part ${part.partNumber} changed.`);
            const partHash = createHash("sha256");
            let partSize = 0;
            for await (const chunk of createReadStream(resolve(directory, `${part.partNumber}.part`))) {
              const bytes = chunk as Buffer;
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
          const metadata: LocalObjectMetadata = {
            key,
            size,
            etag: hash.digest("hex"),
            httpMetadata: upload.httpMetadata,
            customMetadata: upload.customMetadata,
          };
          const published = await this.publish(key, temporary, metadata);
          // Cleanup failure must not report a committed upload as failed.
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          return published;
        } catch (error) {
          await destination.close().catch(() => undefined);
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      },
      abort: async () => {
        await load();
        await rm(directory, { recursive: true, force: true });
      },
    };
  }
}
