export declare function sha256(value: string): Promise<string>;
export declare function passwordHash(password: string, salt: string, iterations: number): Promise<string>;
export declare function constantTimeEqual(left: string, right: string): boolean;
/**
 * Constant-time comparison for secrets whose length is itself sensitive.
 *
 * Hashing both sides first pins the comparison to two fixed-width 32-byte
 * digests, so an attacker learns nothing about the configured secret's length
 * or content from response timing. Use this for any secret compared against an
 * operator-supplied value (admin keys, shared secrets, webhook secrets).
 */
export declare function constantTimeEqualSecret(left: string, right: string): Promise<boolean>;
