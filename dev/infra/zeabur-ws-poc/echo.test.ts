// POL-7 · echo 处理器与 soak 百分位单元测试（bun test dev/infra/zeabur-ws-poc/）
import { expect, test } from "bun:test";
import { handleMessage } from "./echo.ts";
import { percentile } from "./soak-test.ts";

test('ping → pong（带服务器时间戳）', () => {
  expect(handleMessage('{"type":"ping"}', 1234)).toBe('{"type":"pong","t":1234}');
  expect(handleMessage('{"type":"ping","t":42}', 1234)).toBe('{"type":"pong","t":1234}');
});

test('非 JSON 文本原样回发（echo）', () => {
  expect(handleMessage("hello relay", 1)).toBe("hello relay");
  expect(handleMessage("", 1)).toBe("");
});

test('其它 JSON 消息原样回发（echo），不被改写', () => {
  const raw = '{"type":"msg","body":{"envelope":"v1"}}';
  expect(handleMessage(raw, 9)).toBe(raw);
});

test("percentile 就近秩：p50/p95", () => {
  const oneTo100 = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(percentile(oneTo100, 50)).toBe(50);
  expect(percentile(oneTo100, 95)).toBe(95);
  expect(percentile([7], 95)).toBe(7);
  expect(percentile([], 95)).toBe(0);
});
