import { expect, it } from "vitest";
import { assertSecureApiUrl } from "../vite.config";

it.each(["https://api.example.com", "http://localhost:3000", "http://127.0.0.1:3000"])("accepts %s", (url) => {
  expect(() => assertSecureApiUrl(url)).not.toThrow();
});
it.each([undefined, "", "http://api.example.com", "http://helio-alb-123.eu-west-3.elb.amazonaws.com", "http://localhost.example.com", "ftp://api.example.com"])(
  "refuses a build targeting %s", (url) => {
    expect(() => assertSecureApiUrl(url)).toThrow("https://");
  });
