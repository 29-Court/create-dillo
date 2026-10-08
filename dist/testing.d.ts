import type { RuntimeDatabase, ObjectStorage } from "./runtime.js";
/** Run only against disposable test resources. Creates and removes probe data. */
export declare function checkAdapter({ database, storage }: {
    database: RuntimeDatabase;
    storage: ObjectStorage;
}): Promise<{
    checks: string[];
}>;
