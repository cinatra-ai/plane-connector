// Test stub for the `server-only` import marker. In the host bundle
// `server-only` throws if imported from a client component; under vitest
// (node environment) we replace it with a no-op so server modules can be
// unit-tested directly. Mirrors the twenty-connector test stub.
export {};
