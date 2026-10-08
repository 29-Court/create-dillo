export declare function bytesToBase64Url(bytes: Uint8Array): string;
export declare function randomToken(bytes?: number): string;
export declare function sha256Hex(value: string): Promise<string>;
export declare function makeId(prefix: string): string;
export declare function nowIso(): string;
export declare function addSecondsIso(seconds: number, from?: Date): string;
