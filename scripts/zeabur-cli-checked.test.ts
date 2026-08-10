import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runWithFakeNpx(body: string) {
  const root = await mkdtemp(join(tmpdir(), "zeabur-cli-checked-"));
  roots.push(root);
  const fakeNpx = join(root, "npx");
  await writeFile(fakeNpx, `#!/bin/sh\n${body}\n`);
  await chmod(fakeNpx, 0o755);

  return Bun.spawnSync({
    cmd: [
      "bash",
      "scripts/zeabur-cli-checked.sh",
      "service",
      "exec",
      "--id",
      "service-id",
      "--",
      "true",
    ],
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("checked Zeabur CLI wrapper", () => {
  it("preserves successful command output", async () => {
    const result = await runWithFakeNpx(
      "printf '\\033[34mINFO\\033[0m release published\\n'; exit 0",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("release published");
  });

  it("fails when the CLI prints a GraphQL error but exits zero", async () => {
    const result = await runWithFakeNpx(
      "printf '\\033[31mERROR\\033[0m execute command failed: INTERNAL_ERROR traceID:abc123 https://signed.example/secret\\n'; exit 0",
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain("Zeabur CLI command failed (traceID:abc123)");
    expect(output).not.toContain("signed.example");
  });

  it("fails without echoing output from a non-zero command", async () => {
    const result = await runWithFakeNpx("echo 'token=do-not-print'; exit 7");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.exitCode).toBe(1);
    expect(output).toContain("Zeabur CLI command failed");
    expect(output).not.toContain("do-not-print");
  });
});
