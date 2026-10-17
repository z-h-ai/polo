// tsc-side view of @polo-ai/shared/protocol for the mobile app (POL-5).
//
// Why a shim instead of the real source: the app tsconfig program carries
// global typings that packages/* were never written against (expo-router's
// metro-require.d.ts augments NodeJS.ProcessEnv with a required NODE_ENV;
// lib DOM's URL clashes with @types/node's), and those augmentations apply
// program-wide, so letting tsc follow imports into packages/*/src breaks on
// files that are green in their own tsconfig (checked by `typecheck:all`).
// The card forbids touching packages/*, so the app checks its usage against
// this curated surface while Metro keeps bundling the REAL shared source
// (verified by `bunx expo export`); extend this file as App cards consume
// more of the protocol — a missing export fails loudly in tsc.
export declare const PROTOCOL_VERSION: string;
