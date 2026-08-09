import { z } from 'zod';
export declare const CreatorSkillOperationIdSchema: z.ZodString;
export declare const SkillArchivePolicySchema: z.ZodObject<{
    version: z.ZodString;
    maxArchiveBytes: z.ZodNumber;
    maxFileCount: z.ZodNumber;
    maxFileBytes: z.ZodNumber;
    maxExpandedBytes: z.ZodNumber;
}, z.core.$strip>;
export declare const SkillValidationIssueSchema: z.ZodObject<{
    code: z.ZodString;
    severity: z.ZodEnum<{
        error: "error";
        warning: "warning";
    }>;
    path: z.ZodString;
    field: z.ZodOptional<z.ZodString>;
    message: z.ZodString;
    suggestion: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** Decodes persisted metadata through the same Creator Skill constraint core. */
export declare const SkillVersionMetadataSchema: z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>;
export declare const CreatorArtifactSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    organizationId: z.ZodString;
    name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"emoji">;
        value: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"image">;
        url: z.ZodString;
    }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
        kind: "emoji";
        value: string;
    } | {
        kind: "image";
        url: string;
    }> | undefined, {
        kind: "emoji";
        value: string;
    } | {
        kind: "image";
        url: string;
    } | null | undefined>>>;
    status: z.ZodEnum<{
        draft: "draft";
        published: "published";
        archived: "archived";
    }>;
    latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    createdByUserId: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    type: z.ZodLiteral<"web_app">;
    slug: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    organizationId: z.ZodString;
    name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"emoji">;
        value: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"image">;
        url: z.ZodString;
    }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
        kind: "emoji";
        value: string;
    } | {
        kind: "image";
        url: string;
    }> | undefined, {
        kind: "emoji";
        value: string;
    } | {
        kind: "image";
        url: string;
    } | null | undefined>>>;
    status: z.ZodEnum<{
        draft: "draft";
        published: "published";
        archived: "archived";
    }>;
    latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    createdByUserId: z.ZodString;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    type: z.ZodLiteral<"skill">;
    slug: z.ZodString;
}, z.core.$strip>], "type">;
export declare const CreatorArtifactDetailVersionSchema: z.ZodObject<{
    id: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    changelog: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    status: z.ZodEnum<{
        published: "published";
        upload_pending: "upload_pending";
        uploaded: "uploaded";
        validating: "validating";
        validation_failed: "validation_failed";
        validated: "validated";
        revoked: "revoked";
        expired: "expired";
    }>;
    archiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    contentDigest: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    sizeBytes: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>]>>>, z.ZodTransform<number | undefined, number | null | undefined>>>;
    createdAt: z.ZodString;
    publishedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    publishedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revokedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revokedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revocationReason: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validationPolicy: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        version: z.ZodString;
        maxArchiveBytes: z.ZodNumber;
        maxFileCount: z.ZodNumber;
        maxFileBytes: z.ZodNumber;
        maxExpandedBytes: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodTransform<{
        version: string;
        maxArchiveBytes: number;
        maxFileCount: number;
        maxFileBytes: number;
        maxExpandedBytes: number;
    } | undefined, {
        version: string;
        maxArchiveBytes: number;
        maxFileCount: number;
        maxFileBytes: number;
        maxExpandedBytes: number;
    } | null | undefined>>>;
    validatorVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validatedArchiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validatedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    metadata: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>>>, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata | undefined, import("./metadata.ts").CreatorSkillMetadata | null | undefined>>>;
    validationIssues: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        severity: z.ZodEnum<{
            error: "error";
            warning: "warning";
        }>;
        path: z.ZodString;
        field: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
        suggestion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>>, z.ZodTransform<{
        code: string;
        severity: "error" | "warning";
        path: string;
        message: string;
        field?: string | undefined;
        suggestion?: string | undefined;
    }[] | undefined, {
        code: string;
        severity: "error" | "warning";
        path: string;
        message: string;
        field?: string | undefined;
        suggestion?: string | undefined;
    }[] | null | undefined>>>;
}, z.core.$strip>;
export declare const CreatorArtifactVersionSchema: z.ZodObject<{
    id: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    changelog: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    status: z.ZodEnum<{
        published: "published";
        upload_pending: "upload_pending";
        uploaded: "uploaded";
        validating: "validating";
        validation_failed: "validation_failed";
        validated: "validated";
        revoked: "revoked";
        expired: "expired";
    }>;
    archiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    contentDigest: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    sizeBytes: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>]>>>, z.ZodTransform<number | undefined, number | null | undefined>>>;
    createdAt: z.ZodString;
    publishedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    publishedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revokedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revokedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    revocationReason: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validationPolicy: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
        version: z.ZodString;
        maxArchiveBytes: z.ZodNumber;
        maxFileCount: z.ZodNumber;
        maxFileBytes: z.ZodNumber;
        maxExpandedBytes: z.ZodNumber;
    }, z.core.$strip>>>, z.ZodTransform<{
        version: string;
        maxArchiveBytes: number;
        maxFileCount: number;
        maxFileBytes: number;
        maxExpandedBytes: number;
    } | undefined, {
        version: string;
        maxArchiveBytes: number;
        maxFileCount: number;
        maxFileBytes: number;
        maxExpandedBytes: number;
    } | null | undefined>>>;
    validatorVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validatedArchiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    validatedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    metadata: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>>>, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata | undefined, import("./metadata.ts").CreatorSkillMetadata | null | undefined>>>;
    validationIssues: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        severity: z.ZodEnum<{
            error: "error";
            warning: "warning";
        }>;
        path: z.ZodString;
        field: z.ZodOptional<z.ZodString>;
        message: z.ZodString;
        suggestion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>>, z.ZodTransform<{
        code: string;
        severity: "error" | "warning";
        path: string;
        message: string;
        field?: string | undefined;
        suggestion?: string | undefined;
    }[] | undefined, {
        code: string;
        severity: "error" | "warning";
        path: string;
        message: string;
        field?: string | undefined;
        suggestion?: string | undefined;
    }[] | null | undefined>>>;
    uploadGeneration: z.ZodNumber;
}, z.core.$strip>;
export declare const CreatorArtifactCapabilitySchema: z.ZodObject<{
    creatorSkillArtifacts: z.ZodBoolean;
}, z.core.$strip>;
export declare const CreatorArtifactCatalogPageSchema: z.ZodObject<{
    artifacts: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"web_app">;
        slug: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"skill">;
        slug: z.ZodString;
    }, z.core.$strip>], "type">>;
    nextCursor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CreatorArtifactDetailSchema: z.ZodObject<{
    artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"web_app">;
        slug: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"skill">;
        slug: z.ZodString;
    }, z.core.$strip>], "type">;
    versions: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        artifactId: z.ZodString;
        version: z.ZodString;
        changelog: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        status: z.ZodEnum<{
            published: "published";
            upload_pending: "upload_pending";
            uploaded: "uploaded";
            validating: "validating";
            validation_failed: "validation_failed";
            validated: "validated";
            revoked: "revoked";
            expired: "expired";
        }>;
        archiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        contentDigest: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        sizeBytes: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>]>>>, z.ZodTransform<number | undefined, number | null | undefined>>>;
        createdAt: z.ZodString;
        publishedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        publishedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revocationReason: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validationPolicy: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            version: z.ZodString;
            maxArchiveBytes: z.ZodNumber;
            maxFileCount: z.ZodNumber;
            maxFileBytes: z.ZodNumber;
            maxExpandedBytes: z.ZodNumber;
        }, z.core.$strip>>>, z.ZodTransform<{
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | undefined, {
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | null | undefined>>>;
        validatorVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedArchiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        metadata: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>>>, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata | undefined, import("./metadata.ts").CreatorSkillMetadata | null | undefined>>>;
        validationIssues: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            code: z.ZodString;
            severity: z.ZodEnum<{
                error: "error";
                warning: "warning";
            }>;
            path: z.ZodString;
            field: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
            suggestion: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>>, z.ZodTransform<{
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | undefined, {
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | null | undefined>>>;
    }, z.core.$strip>>;
    selectedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
    skillContent: z.ZodOptional<z.ZodString>;
    fileTree: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        size: z.ZodNumber;
        sha256: z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>;
    }, z.core.$strip>>>;
    reference: z.ZodOptional<z.ZodObject<{
        path: z.ZodString;
        content: z.ZodOptional<z.ZodString>;
        downloadUrl: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const CreatorArtifactMutationResponseSchema: z.ZodObject<{
    artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"web_app">;
        slug: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        organizationId: z.ZodString;
        name: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        summary: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        displayIcon: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"emoji">;
            value: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"image">;
            url: z.ZodString;
        }, z.core.$strip>], "kind">>>, z.ZodTransform<NonNullable<{
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        }> | undefined, {
            kind: "emoji";
            value: string;
        } | {
            kind: "image";
            url: string;
        } | null | undefined>>>;
        status: z.ZodEnum<{
            draft: "draft";
            published: "published";
            archived: "archived";
        }>;
        latestPublishedVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        createdByUserId: z.ZodString;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
        archivedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        archivedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        type: z.ZodLiteral<"skill">;
        slug: z.ZodString;
    }, z.core.$strip>], "type">;
    replayed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const CreatorArtifactVersionMutationResponseSchema: z.ZodObject<{
    version: z.ZodObject<{
        id: z.ZodString;
        artifactId: z.ZodString;
        version: z.ZodString;
        changelog: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        status: z.ZodEnum<{
            published: "published";
            upload_pending: "upload_pending";
            uploaded: "uploaded";
            validating: "validating";
            validation_failed: "validation_failed";
            validated: "validated";
            revoked: "revoked";
            expired: "expired";
        }>;
        archiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        contentDigest: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        sizeBytes: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>]>>>, z.ZodTransform<number | undefined, number | null | undefined>>>;
        createdAt: z.ZodString;
        publishedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        publishedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revocationReason: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validationPolicy: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            version: z.ZodString;
            maxArchiveBytes: z.ZodNumber;
            maxFileCount: z.ZodNumber;
            maxFileBytes: z.ZodNumber;
            maxExpandedBytes: z.ZodNumber;
        }, z.core.$strip>>>, z.ZodTransform<{
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | undefined, {
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | null | undefined>>>;
        validatorVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedArchiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        metadata: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>>>, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata | undefined, import("./metadata.ts").CreatorSkillMetadata | null | undefined>>>;
        validationIssues: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            code: z.ZodString;
            severity: z.ZodEnum<{
                error: "error";
                warning: "warning";
            }>;
            path: z.ZodString;
            field: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
            suggestion: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>>, z.ZodTransform<{
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | undefined, {
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | null | undefined>>>;
        uploadGeneration: z.ZodNumber;
    }, z.core.$strip>;
    replayed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const CreatorSkillUploadGrantSchema: z.ZodObject<{
    method: z.ZodLiteral<"PUT">;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    expiresAt: z.ZodString;
    uploadGeneration: z.ZodNumber;
    expectedSizeBytes: z.ZodNumber;
    expectedArchiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
}, z.core.$strip>;
export declare const CreatorArtifactVersionCreatedResponseSchema: z.ZodObject<{
    version: z.ZodObject<{
        id: z.ZodString;
        artifactId: z.ZodString;
        version: z.ZodString;
        changelog: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        status: z.ZodEnum<{
            published: "published";
            upload_pending: "upload_pending";
            uploaded: "uploaded";
            validating: "validating";
            validation_failed: "validation_failed";
            validated: "validated";
            revoked: "revoked";
            expired: "expired";
        }>;
        archiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        contentDigest: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        sizeBytes: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodPipe<z.ZodString, z.ZodTransform<number, string>>]>>>, z.ZodTransform<number | undefined, number | null | undefined>>>;
        createdAt: z.ZodString;
        publishedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        publishedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revokedByUserId: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        revocationReason: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validationPolicy: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodObject<{
            version: z.ZodString;
            maxArchiveBytes: z.ZodNumber;
            maxFileCount: z.ZodNumber;
            maxFileBytes: z.ZodNumber;
            maxExpandedBytes: z.ZodNumber;
        }, z.core.$strip>>>, z.ZodTransform<{
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | undefined, {
            version: string;
            maxArchiveBytes: number;
            maxFileCount: number;
            maxFileBytes: number;
            maxExpandedBytes: number;
        } | null | undefined>>>;
        validatorVersion: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedArchiveChecksum: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        validatedAt: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodString>>, z.ZodTransform<string | undefined, string | null | undefined>>>;
        metadata: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodPipe<z.ZodUnknown, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata, unknown>>>>, z.ZodTransform<import("./metadata.ts").CreatorSkillMetadata | undefined, import("./metadata.ts").CreatorSkillMetadata | null | undefined>>>;
        validationIssues: z.ZodOptional<z.ZodPipe<z.ZodOptional<z.ZodNullable<z.ZodArray<z.ZodObject<{
            code: z.ZodString;
            severity: z.ZodEnum<{
                error: "error";
                warning: "warning";
            }>;
            path: z.ZodString;
            field: z.ZodOptional<z.ZodString>;
            message: z.ZodString;
            suggestion: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>>, z.ZodTransform<{
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | undefined, {
            code: string;
            severity: "error" | "warning";
            path: string;
            message: string;
            field?: string | undefined;
            suggestion?: string | undefined;
        }[] | null | undefined>>>;
        uploadGeneration: z.ZodNumber;
    }, z.core.$strip>;
    replayed: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export declare const CreatorSkillManifestEntrySchema: z.ZodObject<{
    path: z.ZodString;
    size: z.ZodNumber;
    sha256: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
}, z.core.$strip>;
export declare const CreatorSkillDownloadGrantSchema: z.ZodObject<{
    artifactId: z.ZodString;
    organizationId: z.ZodString;
    slug: z.ZodString;
    version: z.ZodString;
    url: z.ZodString;
    expiresAt: z.ZodString;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    contentDigest: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    manifest: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        size: z.ZodNumber;
        sha256: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    }, z.core.$strip>>;
    validationPolicy: z.ZodObject<{
        version: z.ZodString;
        maxArchiveBytes: z.ZodNumber;
        maxFileCount: z.ZodNumber;
        maxFileBytes: z.ZodNumber;
        maxExpandedBytes: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const CreatorSkillSafetyStatusSchema: z.ZodObject<{
    artifactId: z.ZodString;
    version: z.ZodString;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    status: z.ZodEnum<{
        archived: "archived";
        revoked: "revoked";
        active: "active";
    }>;
    safeVersion: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CreatorSkillSafetyStatusBatchSchema: z.ZodObject<{
    statuses: z.ZodArray<z.ZodObject<{
        artifactId: z.ZodString;
        version: z.ZodString;
        archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        status: z.ZodEnum<{
            archived: "archived";
            revoked: "revoked";
            active: "active";
        }>;
        safeVersion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const InstalledCreatorSkillSchema: z.ZodObject<{
    artifactId: z.ZodString;
    organizationId: z.ZodString;
    slug: z.ZodString;
    version: z.ZodString;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    contentDigest: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    installedAt: z.ZodString;
    lastKnownStatus: z.ZodOptional<z.ZodEnum<{
        archived: "archived";
        revoked: "revoked";
        active: "active";
    }>>;
    lastCheckedAt: z.ZodOptional<z.ZodString>;
    ignoredVersion: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CreatorSkillsLedgerSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    installed: z.ZodArray<z.ZodObject<{
        artifactId: z.ZodString;
        organizationId: z.ZodString;
        slug: z.ZodString;
        version: z.ZodString;
        archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        contentDigest: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        installedAt: z.ZodString;
        lastKnownStatus: z.ZodOptional<z.ZodEnum<{
            archived: "archived";
            revoked: "revoked";
            active: "active";
        }>>;
        lastCheckedAt: z.ZodOptional<z.ZodString>;
        ignoredVersion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const CreateCreatorArtifactRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    type: z.ZodLiteral<"skill">;
    slug: z.ZodString;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const CreatorArtifactListRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    type: z.ZodOptional<z.ZodEnum<{
        web_app: "web_app";
        skill: "skill";
    }>>;
    includeDrafts: z.ZodOptional<z.ZodBoolean>;
    cursor: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const CreatorArtifactIdRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodOptional<z.ZodString>;
    referencePath: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const CreateCreatorArtifactVersionRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    changelog: z.ZodOptional<z.ZodString>;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const CreatorArtifactVersionRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const CreatorArtifactArchiveRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    archived: z.ZodBoolean;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const CreatorArtifactUploadGrantRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    sizeBytes: z.ZodNumber;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    idempotencyKey: z.ZodString;
}, z.core.$strict>;
export declare const CreatorArtifactUploadCompleteRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    idempotencyKey: z.ZodString;
    uploadGeneration: z.ZodNumber;
    sizeBytes: z.ZodNumber;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
}, z.core.$strict>;
export declare const CreatorArtifactRevokeRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    idempotencyKey: z.ZodString;
    reason: z.ZodString;
}, z.core.$strict>;
export declare const CreatorSkillDownloadRpcInputSchema: z.ZodObject<{
    organizationId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
}, z.core.$strict>;
export declare const CreatorSkillTargetRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
}, z.core.$strict>;
export declare const DeleteSkillRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    skillSlug: z.ZodString;
}, z.core.$strict>;
export declare const CreatorSkillSafetyRpcInputSchema: z.ZodObject<{
    artifactId: z.ZodString;
    version: z.ZodString;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
}, z.core.$strict>;
export declare const CreatorSkillInstallRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    operationId: z.ZodString;
    grant: z.ZodObject<{
        artifactId: z.ZodString;
        organizationId: z.ZodString;
        slug: z.ZodString;
        version: z.ZodString;
        url: z.ZodString;
        expiresAt: z.ZodString;
        archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        contentDigest: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        manifest: z.ZodArray<z.ZodObject<{
            path: z.ZodString;
            size: z.ZodNumber;
            sha256: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        }, z.core.$strip>>;
        validationPolicy: z.ZodObject<{
            version: z.ZodString;
            maxArchiveBytes: z.ZodNumber;
            maxFileCount: z.ZodNumber;
            maxFileBytes: z.ZodNumber;
            maxExpandedBytes: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    replaceExisting: z.ZodOptional<z.ZodBoolean>;
    confirmGlobalOverride: z.ZodOptional<z.ZodBoolean>;
    backupLocalChanges: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const CreatorSkillUninstallRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    operationId: z.ZodString;
    slug: z.ZodString;
    forceDeleteModified: z.ZodOptional<z.ZodBoolean>;
    forceDeleteCredential: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const CreatorSkillBackupRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
}, z.core.$strict>;
export declare const CreatorSkillBackupDeleteRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    backup: z.ZodOptional<z.ZodObject<{
        slug: z.ZodString;
        backupId: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const CreatorSkillStatusUpdateRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    status: z.ZodObject<{
        artifactId: z.ZodString;
        version: z.ZodString;
        archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
        status: z.ZodEnum<{
            archived: "archived";
            revoked: "revoked";
            active: "active";
        }>;
        safeVersion: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    checkedAt: z.ZodString;
}, z.core.$strict>;
export declare const CreatorSkillIgnoreVersionRpcInputSchema: z.ZodObject<{
    workspaceId: z.ZodString;
    artifactId: z.ZodString;
    version: z.ZodString;
    archiveChecksum: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
    ignoredVersion: z.ZodString;
}, z.core.$strict>;
export declare const StableSemverSchema: z.ZodString;
export declare const SkillSlugSchema: z.ZodString;
