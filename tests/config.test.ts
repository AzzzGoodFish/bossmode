import {describe,it,expect} from "vitest";
import {hashPassword,verifyPassword} from "../src/api/auth.js";
import {isProcessRunning} from "../src/app/process.js";

describe("password hashing",()=>{
  it("hashes with a fresh salt and verifies only the matching password",()=>{
    const first=hashPassword("mypassword"),second=hashPassword("mypassword");
    expect(first).toContain(":");expect(first).not.toBe(second);
    expect(verifyPassword("mypassword",first)).toBe(true);
    expect(verifyPassword("wrongpassword",first)).toBe(false);
  });
  it("rejects malformed stored hashes",()=>{
    expect(verifyPassword("test","")).toBe(false);
    expect(verifyPassword("test","nosalt")).toBe(false);
  });
});

describe("process liveness",()=>{
  it("recognizes the current process and a missing pid",()=>{
    expect(isProcessRunning(process.pid)).toBe(true);
    expect(isProcessRunning(999999)).toBe(false);
  });
});
