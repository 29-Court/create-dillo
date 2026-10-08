import type { ArmadilloDatabase, ArmadilloStatement } from '../backend.js';
import type { SendMailJob } from './mail.js';

/** Facilities used by the engine, implemented by each provider independently. */
export interface EngineDatabase extends ArmadilloDatabase {
  batch(statements: readonly ArmadilloStatement[]): Promise<unknown[]>;
}
export interface StoredObjectMetadata {
  size: number;
  etag: string;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}
export interface StoredObject extends StoredObjectMetadata { body: ReadableStream }
export interface UploadedPart { partNumber: number; etag: string }
export interface MultipartUpload {
  uploadId: string;
  uploadPart(part: number, body: ReadableStream): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<StoredObjectMetadata>;
  abort(): Promise<void>;
}
export interface ObjectStorage {
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<StoredObjectMetadata | null>;
  put(key: string, body: ReadableStream | null, options: { httpMetadata: Record<string, string>; customMetadata?: Record<string, string> }): Promise<StoredObjectMetadata | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(key: string, options: { httpMetadata: Record<string, string>; customMetadata?: Record<string, string> }): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}
export interface RealtimeStub { fetch(request: Request | string, init?: RequestInit): Promise<Response> }
export interface RealtimeNamespace { idFromName(name: string): unknown; get(id: unknown): RealtimeStub }
export interface MailBatch { messages: readonly { id: string; body: SendMailJob; ack(): void; retry(options: { delaySeconds: number }): void }[] }
